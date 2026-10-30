// cavvy-sim: drives one booted iOS simulator for Cavvy (src/simulator/helper.ts builds it with the swiftc of the
// user's own Xcode, which simulators need anyway). It talks to the simulator through Xcode's frameworks, as Xcode's
// Simulator app does, so no Simulator window has to be open: touches and keys go in as the device's own HID events,
// the screen comes out of its framebuffer, and the accessibility tree out of the device's accessibility server.
// Text the tree doesn't have (a web page's, which lives in another process) is read from the screen with Vision.
//
// Usage: cavvy-sim <developer dir> <device UDID>
// Commands arrive on stdin, one JSON object per line, each with an "id". Messages go out on stdout, each a type byte
// ("J" JSON, "F" a JPEG frame of the stream, "S" a PNG screenshot answering a command), a 4-byte big-endian length,
// then the payload. Every command is answered with {"id", "ok"} or {"id", "error"} ("S" carries its id in the JSON
// before it). Events: {"event":"ready"|"size", "width", "height", "scale"} in device pixels (ready with "held":
// whether Xcode's device input service says it has the device's input); {"event":"input", "held"} when that changes,
// as an input is answered (before its answer) or on a timer;
// {"event":"error"}.

import AppKit
import CoreImage
import Foundation
import IOSurface
import ObjectiveC
import Vision

// MARK: - Output

let out = FileHandle.standardOutput
let outLock = NSLock()

func emit(_ type: UInt8, _ payload: Data) {
    var header = Data([type])
    var length = UInt32(payload.count).bigEndian
    header.append(Data(bytes: &length, count: 4))
    outLock.lock()
    defer { outLock.unlock() }
    out.write(header + payload)
}

func emitJSON(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    emit(UInt8(ascii: "J"), data)
}

func fail(_ message: String) -> Never {
    emitJSON(["event": "error", "message": message])
    exit(1)
}

// MARK: - Frameworks

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: cavvy-sim <developer dir> <device UDID>") }
let developerDir = args[1]
let udid = args[2]

guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW) != nil else { fail("CoreSimulator isn't installed") }
let simulatorKitPath = URL(fileURLWithPath: developerDir).deletingLastPathComponent().appendingPathComponent("SharedFrameworks/SimulatorKit.framework/SimulatorKit").path
guard let simulatorKit = dlopen(simulatorKitPath, RTLD_NOW) else { fail("SimulatorKit isn't in this Xcode") }
_ = dlopen("/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/AccessibilityPlatformTranslation", RTLD_NOW)

func symbol<T>(_ name: String, as type: T.Type) -> T {
    guard let p = dlsym(simulatorKit, name) else { fail("This Xcode's SimulatorKit has no \(name)") }
    return unsafeBitCast(p, to: type)
}

typealias MouseMessage = @convention(c) (UnsafePointer<CGPoint>, UnsafePointer<CGPoint>?, UInt32, UInt, UInt, Double, Double) -> UnsafeMutableRawPointer?
typealias ButtonMessage = @convention(c) (UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?
typealias KeyMessage = @convention(c) (UInt32, UInt32) -> UnsafeMutableRawPointer?
let mouseMessage = symbol("IndigoHIDMessageForMouseNSEvent", as: MouseMessage.self)
let buttonMessage = symbol("IndigoHIDMessageForButton", as: ButtonMessage.self)
let keyMessage = symbol("IndigoHIDMessageForKeyboardArbitrary", as: KeyMessage.self)

/// Calls an Objective-C method by name with its implementation cast to `T` (which starts with the receiver and selector).
func imp<T>(_ object: AnyObject, _ name: String, as type: T.Type) -> (T, Selector) {
    let sel = NSSelectorFromString(name)
    guard let cls = object_getClass(object), let fn = class_getMethodImplementation(cls, sel) else { fail("No method \(name)") }
    return (unsafeBitCast(fn, to: type), sel)
}

// MARK: - Device

let device: NSObject = {
    guard let contextClass = NSClassFromString("SimServiceContext") as? NSObject.Type else { fail("CoreSimulator has no SimServiceContext") }
    typealias Shared = @convention(c) (AnyObject, Selector, NSString, UnsafeMutablePointer<NSError?>?) -> AnyObject?
    let (shared, sel) = imp(contextClass, "sharedServiceContextForDeveloperDir:error:", as: Shared.self)
    var error: NSError?
    guard let context = shared(contextClass, sel, developerDir as NSString, &error) as? NSObject else { fail("Can't reach CoreSimulator: \(error?.localizedDescription ?? "unknown")") }
    typealias SetFn = @convention(c) (AnyObject, Selector, UnsafeMutablePointer<NSError?>?) -> AnyObject?
    let (defaultSet, setSel) = imp(context, "defaultDeviceSetWithError:", as: SetFn.self)
    guard let set = defaultSet(context, setSel, &error) as? NSObject, let devices = set.value(forKey: "devices") as? [NSObject] else { fail("Can't list simulators") }
    guard let d = devices.first(where: { ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid }) else { fail("No simulator \(udid)") }
    return d
}()

// MARK: - Input

let hid: AnyObject = {
    guard let cls = NSClassFromString("SimulatorKit.SimDeviceLegacyHIDClient") as? NSObject.Type else { fail("SimulatorKit has no HID client") }
    typealias InitFn = @convention(c) (AnyObject, Selector, AnyObject, UnsafeMutablePointer<NSError?>?) -> AnyObject?
    let sel = NSSelectorFromString("initWithDevice:error:")
    guard let fn = class_getMethodImplementation(cls, sel) else { fail("SimulatorKit's HID client has changed") }
    var error: NSError?
    guard let client = unsafeBitCast(fn, to: InitFn.self)(cls.perform(NSSelectorFromString("alloc"))!.takeUnretainedValue(), sel, device, &error) else { fail("Can't send input to the simulator: \(error?.localizedDescription ?? "unknown")") }
    return client
}()

typealias SendFn = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Bool, DispatchQueue?, (@convention(block) (NSError?) -> Void)?) -> Void
let (sendImp, sendSel) = imp(hid, "sendWithMessage:freeWhenDone:completionQueue:completion:", as: SendFn.self)
let hidQueue = DispatchQueue(label: "cavvy-sim.hid")

/// Sends one HID message and waits until the device took it. The message is freed by SimulatorKit.
func send(_ message: UnsafeMutableRawPointer?) throws {
    guard let message else { return }
    let done = DispatchSemaphore(value: 0)
    var failure: NSError?
    sendImp(hid, sendSel, message, true, hidQueue) { e in
        failure = e
        done.signal()
    }
    if done.wait(timeout: .now() + 5) == .timedOut { throw HelperError("The simulator didn't take the input") }
    if let failure { throw HelperError(failure.localizedDescription) }
}

// The digitizer (the touch screen) and the hardware buttons, as SimulatorKit names its targets.
let touchTarget: UInt32 = 0x32
let buttonTarget: UInt32 = 0x33
// NSEvent types the touch message is built from.
let touchDown: UInt = 1, touchUp: UInt = 2, touchMove: UInt = 6

// Input (touches, buttons, keys) runs in order on its own queue, never behind reading the screen.
let inputQueue = DispatchQueue(label: "cavvy-sim.input")
// On inputQueue: the newest move not sent yet, and when the last touch went.
var pendingMove: CGPoint?
var moveScheduled = false
var lastTouch = Date.distantPast
/// SimulatorKit makes no message for a move within 16 ms of the last touch event.
let moveGap = 0.017

/// A touch at a point given as a fraction of the screen (0…1 on each side). On inputQueue. Moves come as fast as a
/// pointer moves; only the newest is sent, once the gap since the last has passed, so they never pile up.
func touch(_ phase: UInt, _ x: Double, _ y: Double) throws {
    let p = CGPoint(x: min(max(x, 0), 1), y: min(max(y, 0), 1))
    if phase == touchMove {
        pendingMove = p
        scheduleMove()
        return
    }
    // The finger going down or up says where it is: a move still waiting is behind it.
    pendingMove = nil
    try sendTouch(phase, p)
}

func sendTouch(_ phase: UInt, _ p: CGPoint) throws {
    var q = p
    guard let message = mouseMessage(&q, nil, touchTarget, phase, 0, 1, 1) else { return }
    lastTouch = Date()
    try send(message)
}

func scheduleMove() {
    guard !moveScheduled else { return }
    moveScheduled = true
    inputQueue.asyncAfter(deadline: .now() + max(0, moveGap - Date().timeIntervalSince(lastTouch))) {
        moveScheduled = false
        guard let p = pendingMove else { return }
        pendingMove = nil
        try? sendTouch(touchMove, p)
    }
}

// Siri's (0x400002) is left out: on Xcode 27 pressing it ends SpringBoard.
let buttons: [String: UInt32] = ["home": 0x0, "lock": 0x1]

func button(_ name: String, _ phase: String?) throws {
    guard let source = buttons[name] else { throw HelperError("Unknown button \(name)") }
    if phase != "up" { try send(buttonMessage(source, 1, buttonTarget)) }
    if phase == nil { usleep(80_000) }
    if phase != "down" { try send(buttonMessage(source, 2, buttonTarget)) }
}

/// HID keyboard usages, each pressed (down) or released, in order, with `gap` seconds after each release.
func keys(_ list: [[Any]], gap: Double = 0) throws {
    for k in list {
        guard k.count == 2, let usage = (k[0] as? NSNumber)?.uint32Value, let down = k[1] as? Bool else { throw HelperError("Bad key") }
        try send(keyMessage(usage, down ? 1 : 2))
        if gap > 0 && !down { usleep(UInt32(gap * 1_000_000)) }
    }
}

// Xcode's device input service in the simulator (dtuhidd) takes over the device's input for a tool that uses it, as
// Claude's desktop app does. When it starts, the simulator lets go of each of the touch screen, keyboard and buttons
// that hasn't had input yet, and input sent to them goes nowhere, without an error, until the device's input process
// restarts. The service says it has started in a notification state, which CoreSimulator reads; which inputs were
// let go, Cavvy reads from the device's log (simctl.ts).
typealias GetStateFn = @convention(c) (AnyObject, Selector, UnsafeMutablePointer<UInt64>, NSString, UnsafeMutablePointer<NSError?>?) -> Bool
let getState: (GetStateFn, Selector)? = device.responds(to: NSSelectorFromString("darwinNotificationGetState:name:error:")) ? imp(device, "darwinNotificationGetState:name:error:", as: GetStateFn.self) : nil

/// Whether Xcode's device input service says it has the device's input.
func inputHeld() -> Bool {
    guard let (fn, sel) = getState else { return false }
    var value: UInt64 = 0
    return fn(device, sel, &value, "com.apple.coredevice.dtuhidd.active" as NSString, nil) && value != 0
}

/// What Cavvy was last told of it, by the ready event or the timer: each change is told once, in order.
let heldLock = NSLock()
var heldSaid = false

/// Tells Cavvy whether the service has the input: in `event` (the ready event), or on its own when it's changed.
func tellHeld(in event: [String: Any]? = nil) {
    heldLock.lock()
    defer { heldLock.unlock() }
    let held = inputHeld()
    if var event {
        event["held"] = held
        emitJSON(event)
    } else if held != heldSaid {
        emitJSON(["event": "input", "held": held])
    }
    heldSaid = held
}

/// An input command's answer: before it, whether the service has the device's input if that's changed (it may have
/// taken over as the input went).
func inputAnswer() -> [String: Any] {
    tellHeld()
    return ["ok": true]
}

/// Each input let go of where nothing is down (a touch, a key, Home), which does nothing on the device but counts as
/// input: the simulator then keeps them when the service starts again. One in use (a finger down) is left as it is.
func claim(touchScreen: Bool, keyboard: Bool, buttons: Bool) throws {
    if touchScreen { try touch(touchUp, 0.5, 0.5) }
    if keyboard { try keys([[NSNumber(value: 0xE1), false]]) }  // Left Shift
    if buttons { try button("home", "up") }
}

// MARK: - Screen

let screen: NSObject = {
    guard let io = device.value(forKey: "io") as? NSObject else { fail("The simulator has no IO") }
    typealias Ports = @convention(c) (AnyObject, Selector) -> AnyObject?
    let (portsFn, portsSel) = imp(io, "ioPorts", as: Ports.self)
    let ports = (portsFn(io, portsSel) as? [NSObject]) ?? []
    var best: (NSObject, Int)?
    for port in ports {
        guard let descriptor = port.perform(NSSelectorFromString("descriptor"))?.takeUnretainedValue() as? NSObject else { continue }
        guard descriptor.responds(to: NSSelectorFromString("registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:")) else { continue }
        guard let surface = descriptor.perform(NSSelectorFromString("framebufferSurface"))?.takeUnretainedValue() as? IOSurface else { continue }
        let area = surface.width * surface.height
        if best == nil || area > best!.1 { best = (descriptor, area) }
    }
    guard let found = best?.0 else { fail("The simulator has no screen. Is it booted?") }
    return found
}()

let scale: Double = {
    if let type = device.value(forKey: "deviceType") as? NSObject, let s = type.value(forKey: "mainScreenScale") as? NSNumber { return s.doubleValue }
    return 3
}()

let screenQueue = DispatchQueue(label: "cavvy-sim.screen")
let ciContext = CIContext(options: [.useSoftwareRenderer: false])
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

func surface() -> IOSurface? {
    screen.perform(NSSelectorFromString("framebufferSurface"))?.takeUnretainedValue() as? IOSurface
}

/// The screen as an image, scaled so its longer side is at most `maxSide` pixels (0: as it is). `sharp`: scaled with
/// Lanczos, which keeps small text crisp, rather than the quicker linear scaling pictures of a moving screen get.
func image(_ s: IOSurface, maxSide: Int, sharp: Bool = false) -> CIImage {
    let img = CIImage(ioSurface: s)
    let longest = max(s.width, s.height)
    guard maxSide > 0 && longest > maxSide else { return img }
    let f = Double(maxSide) / Double(longest)
    let size = CGRect(x: 0, y: 0, width: (Double(s.width) * f).rounded(.down), height: (Double(s.height) * f).rounded(.down))
    if sharp, let lanczos = CIFilter(name: "CILanczosScaleTransform") {
        lanczos.setValue(img, forKey: kCIInputImageKey)
        lanczos.setValue(f, forKey: kCIInputScaleKey)
        lanczos.setValue(1.0, forKey: kCIInputAspectRatioKey)
        if let scaled = lanczos.outputImage { return scaled.cropped(to: size) }
    }
    return img.transformed(by: CGAffineTransform(scaleX: f, y: f)).cropped(to: size)
}

func jpeg(_ s: IOSurface, quality: Double, maxSide: Int, sharp: Bool = false) -> Data? {
    ciContext.jpegRepresentation(of: image(s, maxSide: maxSide, sharp: sharp), colorSpace: sRGB, options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): quality])
}

func png(_ s: IOSurface, maxSide: Int) -> Data? {
    ciContext.pngRepresentation(of: image(s, maxSide: maxSide, sharp: true), format: .RGBA8, colorSpace: sRGB)
}

var lastSize = (0, 0)

/// Tells Cavvy the screen's size when it changes (a rotation, another display mode).
func noteSize(_ s: IOSurface) {
    let size = (s.width, s.height)
    if size == lastSize { return }
    let first = lastSize == (0, 0)
    lastSize = size
    let event: [String: Any] = ["event": first ? "ready" : "size", "width": size.0, "height": size.1, "scale": scale]
    if first { tellHeld(in: event) } else { emitJSON(event) }
}

// The stream: a frame when the screen changes, at most `fps` a second, only the newest when Cavvy reads slower. A
// change after `sharpAfter` without one (a cursor's blink, a tap) goes sharp; changes closer together (scrolling, an
// animation) go quick, and once they stop for `sharpAfter` the screen goes once more, sharp: quick pictures while
// it moves, crisp ones to read, and no picture going soft then sharp for a lone change.
var streaming = false
var fps = 30.0
var quality = 0.7
var sharpQuality = 0.92
let sharpAfter = 0.15
var maxSide = 1600
var dirty = false
var encoding = false
var lastFrame = Date.distantPast
/// When the screen last changed, for "settle", and how many times: a sharp picture is for the screen it was made of.
var lastDamage = Date()
var damage = 0

func frameArrived() {
    screenQueue.async {
        lastDamage = Date()
        damage += 1
        dirty = true
        pump()
    }
}

/// Waits until the screen has been still for `quiet` seconds (an animation ended, a page loaded), and `least` seconds
/// have passed, at most `timeout`.
func settle(quiet: Double, least: Double, timeout: Double) -> Bool {
    // Still from now on: what was just done may not have reached the screen yet (an app can take half a second to
    // start showing a page, and be still until then).
    let start = Date()
    let end = start.addingTimeInterval(timeout)
    while Date() < end {
        let still = screenQueue.sync { Date().timeIntervalSince(max(lastDamage, start)) }
        if still >= quiet && Date().timeIntervalSince(start) >= least { return true }
        usleep(40_000)
    }
    return false
}

/// On screenQueue: encodes the newest picture if the stream is on, the screen changed and the last one is far enough back.
func pump() {
    guard streaming, dirty, !encoding else { return }
    let wait = 1 / fps - Date().timeIntervalSince(lastFrame)
    if wait > 0 {
        encoding = true
        screenQueue.asyncAfter(deadline: .now() + wait) {
            encoding = false
            pump()
        }
        return
    }
    guard let s = surface() else { return }
    dirty = false
    encoding = true
    let sharp = Date().timeIntervalSince(lastFrame) >= sharpAfter
    lastFrame = Date()
    noteSize(s)
    let data = jpeg(s, quality: sharp ? sharpQuality : quality, maxSide: maxSide, sharp: sharp)
    let shown = damage
    DispatchQueue.global(qos: .userInteractive).async {
        if let data { emit(UInt8(ascii: "F"), data) }
        screenQueue.async {
            encoding = false
            pump()
            if !sharp { screenQueue.asyncAfter(deadline: .now() + sharpAfter) { sharpen(shown) } }
        }
    }
}

/// On screenQueue: the still screen's picture again, sharp, unless it has changed since picture `shown` was made.
func sharpen(_ shown: Int) {
    guard streaming, damage == shown, !dirty, !encoding, let s = surface() else { return }
    encoding = true
    let data = jpeg(s, quality: sharpQuality, maxSide: maxSide, sharp: true)
    DispatchQueue.global(qos: .userInitiated).async {
        // A change while it was made shows next, and gets its own sharp picture.
        if let data { emit(UInt8(ascii: "F"), data) }
        screenQueue.async {
            encoding = false
            pump()
        }
    }
}

func registerScreen() {
    typealias Register = @convention(c) (AnyObject, Selector, NSUUID, DispatchQueue, @escaping @convention(block) () -> Void, @escaping @convention(block) () -> Void, @escaping @convention(block) () -> Void) -> Void
    let (register, sel) = imp(screen, "registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:", as: Register.self)
    register(screen, sel, NSUUID(), screenQueue, { frameArrived() }, { frameArrived() }, { frameArrived() })
}

// MARK: - Accessibility

/// Answers the accessibility translator's requests by passing them to the device, as Xcode's Accessibility Inspector does.
final class Bridge: NSObject {
    let queue = DispatchQueue(label: "cavvy-sim.ax")

    @objc(accessibilityTranslationDelegateBridgeCallbackWithToken:)
    func callback(token: NSString) -> Any {
        let block: @convention(block) (AnyObject) -> AnyObject? = { [queue] request in
            typealias SendAX = @convention(c) (AnyObject, Selector, AnyObject, DispatchQueue, @escaping @convention(block) (AnyObject?) -> Void) -> Void
            let (sendAX, sel) = imp(device, "sendAccessibilityRequestAsync:completionQueue:completionHandler:", as: SendAX.self)
            let done = DispatchSemaphore(value: 0)
            var response: AnyObject?
            sendAX(device, sel, request, queue) { r in
                response = r
                done.signal()
            }
            _ = done.wait(timeout: .now() + 3)
            return response ?? emptyResponse()
        }
        return unsafeBitCast(block, to: AnyObject.self)
    }

    @objc(accessibilityTranslationConvertPlatformFrameToSystem:withToken:)
    func convert(rect: CGRect, token: NSString) -> CGRect { rect }

    @objc(accessibilityTranslationRootParentWithToken:)
    func rootParent(token: NSString) -> AnyObject? { nil }
}

func emptyResponse() -> AnyObject? {
    (NSClassFromString("AXPTranslatorResponse") as? NSObject.Type)?.init()
}

let bridge = Bridge()
let token = UUID().uuidString as NSString

let translator: NSObject? = {
    guard let cls = NSClassFromString("AXPTranslator") as? NSObject.Type else { return nil }
    guard let t = cls.perform(NSSelectorFromString("sharedInstance"))?.takeUnretainedValue() as? NSObject else { return nil }
    t.setValue(bridge, forKey: "bridgeTokenDelegate")
    t.setValue(true, forKey: "supportsDelegateTokens")
    t.setValue(true, forKey: "accessibilityEnabled")
    return t
}()

func string(_ element: NSObject, _ name: String) -> String? {
    let sel = NSSelectorFromString(name)
    guard element.responds(to: sel), let value = element.perform(sel)?.takeUnretainedValue() else { return nil }
    if let s = value as? String { return s.isEmpty ? nil : s }
    if let n = value as? NSNumber { return n.stringValue }
    if let a = value as? NSAttributedString { return a.string.isEmpty ? nil : a.string }
    return nil
}

/// One element and what's under it, with its frame in the screen's points.
func describe(_ element: NSObject, depth: Int, budget: inout Int) -> [String: Any]? {
    guard budget > 0, depth < 60 else { return nil }
    budget -= 1
    if let translation = element.value(forKey: "translation") as? NSObject { translation.setValue(token, forKey: "bridgeDelegateToken") }
    var node: [String: Any] = [:]
    node["role"] = string(element, "accessibilityRole")
    node["subrole"] = string(element, "accessibilitySubrole")
    node["label"] = string(element, "accessibilityLabel")
    node["title"] = string(element, "accessibilityTitle")
    node["value"] = string(element, "accessibilityValue")
    node["identifier"] = string(element, "accessibilityIdentifier")
    node["placeholder"] = string(element, "accessibilityPlaceholderValue")
    typealias FrameFn = @convention(c) (AnyObject, Selector) -> CGRect
    let (frameOf, frameSel) = imp(element, "accessibilityFrame", as: FrameFn.self)
    let f = frameOf(element, frameSel)
    node["frame"] = [f.origin.x, f.origin.y, f.size.width, f.size.height].map { ($0 * 10).rounded() / 10 }
    typealias BoolFn = @convention(c) (AnyObject, Selector) -> Bool
    let enabledSel = NSSelectorFromString("isAccessibilityEnabled")
    if element.responds(to: enabledSel) {
        let (enabledOf, _) = imp(element, "isAccessibilityEnabled", as: BoolFn.self)
        if !enabledOf(element, enabledSel) { node["disabled"] = true }
    }
    // Which option is chosen (a checkmarked row, a tab): asked only of what can be chosen, as each question is a trip to the device.
    let selectedSel = NSSelectorFromString("isAccessibilitySelected")
    if ["AXButton", "AXCell", "AXRadioButton", "AXRow", "AXStaticText"].contains(node["role"] as? String ?? ""), element.responds(to: selectedSel) {
        let (selectedOf, _) = imp(element, "isAccessibilitySelected", as: BoolFn.self)
        if selectedOf(element, selectedSel) { node["selected"] = true }
    }
    // What's selected in a field (a tap on Safari's address selects it all): typing replaces it.
    if ["AXTextField", "AXSearchField", "AXTextArea"].contains(node["role"] as? String ?? "") {
        let selectionSel = NSSelectorFromString("accessibilitySelectedTextRange")
        if element.responds(to: selectionSel) {
            typealias RangeFn = @convention(c) (AnyObject, Selector) -> NSRange
            let (selectionOf, _) = imp(element, "accessibilitySelectedTextRange", as: RangeFn.self)
            let r = selectionOf(element, selectionSel)
            if r.location != NSNotFound { node["selection"] = [r.location, r.length] }
        }
    }
    var children: [[String: Any]] = []
    var kids = element.perform(NSSelectorFromString("accessibilityChildren"))?.takeUnretainedValue() as? [NSObject] ?? []
    // A list that gives none of its rows (iPad Settings' sidebar) may still give the chosen one.
    if kids.isEmpty, ["AXGroup", "AXList", "AXOutline", "AXTable"].contains(node["role"] as? String ?? "") {
        kids = element.perform(NSSelectorFromString("accessibilitySelectedChildren"))?.takeUnretainedValue() as? [NSObject] ?? []
    }
    for kid in kids { if let c = describe(kid, depth: depth + 1, budget: &budget) { children.append(c) } }
    if !children.isEmpty { node["children"] = children }
    return node
}

func describeScreen() throws -> [String: Any] {
    guard let translator else { throw HelperError("Accessibility isn't available in this macOS") }
    typealias Frontmost = @convention(c) (AnyObject, Selector, UInt32, NSString) -> AnyObject?
    let (frontmost, sel) = imp(translator, "frontmostApplicationWithDisplayId:bridgeDelegateToken:", as: Frontmost.self)
    guard let app = frontmost(translator, sel, 0, token) as? NSObject else { throw HelperError("Nothing on the screen to read yet.") }
    app.setValue(token, forKey: "bridgeDelegateToken")
    typealias Element = @convention(c) (AnyObject, Selector, AnyObject) -> AnyObject?
    let (elementOf, elSel) = imp(translator, "macPlatformElementFromTranslation:", as: Element.self)
    guard let root = elementOf(translator, elSel, app) as? NSObject else { throw HelperError("Can't read the screen") }
    var budget = 3000
    var reply: [String: Any] = ["tree": describe(root, depth: 0, budget: &budget) ?? [:]]
    // How often the screen has changed, and how long it has been still: whether what was done has shown yet.
    let (changes, still) = screenQueue.sync { (damage, Date().timeIntervalSince(lastDamage)) }
    reply["changes"] = changes
    reply["stillMs"] = Int(still * 1000)
    // Which app is in front (SpringBoard on the home screen): its process runs on this Mac, so its pid is the one
    // `simctl launch` gives.
    if let pid = (app.value(forKey: "pid") as? NSNumber)?.int32Value, pid > 0 {
        reply["pid"] = pid
        var path = [CChar](repeating: 0, count: 4096)
        if proc_pidpath(pid, &path, UInt32(path.count)) > 0 { reply["process"] = URL(fileURLWithPath: String(cString: path)).lastPathComponent }
        // One that's no longer running: the device's bridge still answers for the screen before (its home screen
        // restarted), until the bridge restarts.
        else if kill(pid, 0) != 0 && errno == ESRCH { reply["gone"] = true }
    }
    return reply
}

// MARK: - Text in the picture

/// Vision's text recognition loads its model the first time (seconds, up to half a minute on a Mac that has never
/// used it), so it's loaded in the background at the start; until then, reading the screen's text says so at once.
let textQueue = DispatchQueue(label: "cavvy-sim.text", qos: .userInitiated)
let textLock = NSLock()
var textReady = false

func recognize(_ s: IOSurface) throws -> [[String: Any]] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    // Any script Vision reads (Arabic, Chinese, …), not only English's: a list of languages reads only the first's.
    request.automaticallyDetectsLanguage = true
    try VNImageRequestHandler(ciImage: CIImage(ioSurface: s), options: [:]).perform([request])
    let w = Double(s.width) / scale, h = Double(s.height) / scale
    return (request.results ?? []).flatMap { o -> [[String: Any]] in
        guard let c = o.topCandidates(1).first else { return [] }
        return pieces(c, o.boundingBox, s, w, h).map { text, b in
            // Vision's box is a fraction of the picture from its bottom left; the tree's frames are points from the top left.
            ["text": text, "confidence": Double(c.confidence), "frame": [b.minX * w, (1 - b.maxY) * h, b.width * w, b.height * h].map { ($0 * 10).rounded() / 10 }]
        }
    }
}

/// A line's text in pieces where a wide gap parts it: links side by side ("Domains Protocols Numbers") read as one line,
/// and a ref for each should land on it. Vision spreads a line's words evenly over its box, so the gaps are looked for
/// in the picture: its widest gaps, one fewer than the words, are between the words. When that makes words of unlikely
/// widths (a "|" Vision didn't read, taken for one), the line stays whole. Boxes are fractions of a picture `w`×`h` points.
func pieces(_ c: VNRecognizedText, _ box: CGRect, _ s: IOSurface, _ w: Double, _ h: Double) -> [(String, CGRect)] {
    let text = c.string
    let tokens = text.split(whereSeparator: { $0.isWhitespace })
    guard tokens.count > 1, let runs = inkRuns(s, box), runs.count >= tokens.count else { return [(text, box)] }
    // Arabic's words go right to left.
    let first = try? c.boundingBox(for: tokens[0].startIndex..<tokens[0].endIndex)?.boundingBox
    let last = try? c.boundingBox(for: tokens[tokens.count - 1].startIndex..<tokens[tokens.count - 1].endIndex)?.boundingBox
    let backwards = (first?.minX ?? 0) > (last?.minX ?? 0)
    let between = runs.indices.dropFirst().sorted { runs[$0].lowerBound - runs[$0 - 1].upperBound > runs[$1].lowerBound - runs[$1 - 1].upperBound }.prefix(tokens.count - 1).sorted()
    var words: [Range<Double>] = []
    var start = 0
    for i in between + [runs.count] {
        words.append(runs[start].lowerBound..<runs[i - 1].upperBound)
        start = i
    }
    if backwards { words.reverse() }
    let perCharacter = zip(words, tokens).map { ($0.upperBound - $0.lowerBound) / Double($1.count) }
    guard let least = perCharacter.min(), let most = perCharacter.max(), most <= least * 5 else { return [(text, box)] }
    var out: [(String, CGRect)] = []
    var from = 0
    for i in 1...tokens.count {
        if i < tokens.count {
            let gap = (max(words[i - 1].lowerBound, words[i].lowerBound) - min(words[i - 1].upperBound, words[i].upperBound)) * w
            if gap <= box.height * h * 0.7 { continue }
        }
        let left = min(words[from].lowerBound, words[i - 1].lowerBound), right = max(words[from].upperBound, words[i - 1].upperBound)
        out.append((String(text[tokens[from].startIndex..<tokens[i - 1].endIndex]), CGRect(x: left, y: box.minY, width: right - left, height: box.height)))
        from = i
    }
    return out
}

/// The stretches of a line's box with something drawn in them, left to right, as fractions of the picture's width:
/// columns unlike the background, read just left of the box. On a picture behind the text, one long stretch.
func inkRuns(_ s: IOSurface, _ box: CGRect) -> [Range<Double>]? {
    guard s.bytesPerElement == 4, s.lock(options: .readOnly, seed: nil) == 0 else { return nil }
    defer { s.unlock(options: .readOnly, seed: nil) }
    let width = s.width, height = s.height, row = s.bytesPerRow
    let x0 = max(0, Int(box.minX * Double(width))), x1 = min(width, Int(box.maxX * Double(width)))
    let y0 = max(0, Int((1 - box.maxY) * Double(height))), y1 = min(height, Int((1 - box.minY) * Double(height)))
    guard x1 > x0, y1 > y0 else { return nil }
    let bytes = s.baseAddress.assumingMemoryBound(to: UInt8.self)
    let ground = bytes + ((y0 + y1) / 2) * row + max(0, x0 - 3) * 4
    var runs: [Range<Double>] = []
    var begun: Int?
    for x in x0..<x1 {
        var ink = false
        for y in y0..<y1 {
            let p = bytes + y * row + x * 4
            if abs(Int(p[0]) - Int(ground[0])) + abs(Int(p[1]) - Int(ground[1])) + abs(Int(p[2]) - Int(ground[2])) > 96 {
                ink = true
                break
            }
        }
        if ink, begun == nil { begun = x }
        if !ink, let b = begun {
            runs.append(Double(b) / Double(width)..<Double(x) / Double(width))
            begun = nil
        }
    }
    if let b = begun { runs.append(Double(b) / Double(width)..<Double(x1) / Double(width)) }
    return runs
}

func warmText() {
    DispatchQueue.global(qos: .utility).async {
        if let s = surface() { _ = try? recognize(s) }
        textLock.withLock { textReady = true }
    }
}

// MARK: - Commands

struct HelperError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

/// Reading the screen (its tree, a screenshot, waiting for it to be still) runs on its own queue: it can take seconds.
/// Reading its text runs on another (textQueue), beside the tree: a snapshot asks for both at once. Input runs on its own.
let readQueue = DispatchQueue(label: "cavvy-sim.read")
let queues: [String: DispatchQueue] = ["describe": readQueue, "settle": readQueue, "screenshot": readQueue, "text": textQueue]

func number(_ c: [String: Any], _ key: String) throws -> Double {
    guard let n = c[key] as? NSNumber else { throw HelperError("\(key) is missing") }
    return n.doubleValue
}

func handle(_ c: [String: Any]) throws -> [String: Any] {
    switch c["op"] as? String {
    case "touch":
        let phase: UInt = switch c["phase"] as? String { case "down": touchDown; case "up": touchUp; default: touchMove }
        try touch(phase, try number(c, "x"), try number(c, "y"))
        return inputAnswer()
    case "button":
        try button(c["name"] as? String ?? "", c["phase"] as? String)
        return inputAnswer()
    case "keys":
        try keys(c["keys"] as? [[Any]] ?? [], gap: ((c["gapMs"] as? NSNumber)?.doubleValue ?? 0) / 1000)
        return inputAnswer()
    case "claim":
        try claim(touchScreen: c["touch"] as? Bool ?? true, keyboard: c["keys"] as? Bool ?? true, buttons: c["buttons"] as? Bool ?? true)
    case "stream":
        let on = c["on"] as? Bool ?? false
        screenQueue.sync {
            if let n = c["fps"] as? NSNumber { fps = min(max(n.doubleValue, 1), 60) }
            if let n = c["quality"] as? NSNumber { quality = min(max(n.doubleValue, 0.1), 1) }
            if let n = c["maxSide"] as? NSNumber { maxSide = n.intValue }
            streaming = on
            if on { dirty = true }
            pump()
        }
    case "screenshot":
        guard let s = surface() else { throw HelperError("Can't read the screen") }
        // In points when asked ("points": true), so a place in the picture is a place to touch.
        let side = c["points"] as? Bool == true ? Int((Double(max(s.width, s.height)) / scale).rounded()) : 0
        guard let data = png(s, maxSide: side) else { throw HelperError("Can't read the screen") }
        let f = side > 0 ? Double(side) / Double(max(s.width, s.height)) : 1
        var meta: [String: Any] = ["id": c["id"] ?? 0, "width": Int((Double(s.width) * f).rounded()), "height": Int((Double(s.height) * f).rounded()), "scale": scale]
        meta["bytes"] = data.count
        let header = try JSONSerialization.data(withJSONObject: meta)
        var length = UInt32(header.count).bigEndian
        emit(UInt8(ascii: "S"), Data(bytes: &length, count: 4) + header + data)
        return [:]
    case "describe":
        return try describeScreen()
    case "text":
        guard textLock.withLock({ textReady }) else { return ["lines": [], "loading": true] }
        guard let s = surface() else { throw HelperError("Can't read the screen") }
        // Vision's own errors name its internals (e5rtError…), which say nothing to Cavvy's user.
        guard let lines = try? recognize(s) else { throw HelperError("Vision couldn't read the picture") }
        return ["lines": lines]
    case "settle":
        let still = settle(quiet: ((c["quietMs"] as? NSNumber)?.doubleValue ?? 300) / 1000, least: ((c["leastMs"] as? NSNumber)?.doubleValue ?? 0) / 1000, timeout: ((c["timeoutMs"] as? NSNumber)?.doubleValue ?? 3000) / 1000)
        return ["settled": still]
    case "size":
        guard let s = surface() else { throw HelperError("Can't read the screen") }
        return ["width": s.width, "height": s.height, "scale": scale]
    default:
        throw HelperError("Unknown command")
    }
    return ["ok": true]
}

registerScreen()
if let s = surface() { noteSize(s) }
warmText()

// A device that shuts down (elsewhere, or to restart) takes its screen and input with it, and they don't come back
// when it starts again: the helper ends with it, and Cavvy starts another for the device's next start. Whether
// Xcode's device input service has its input is said as it changes.
let shutdownStates: Set<Int> = [1, 4]  // SimDeviceState: shut down, shutting down
let stateWatch = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
stateWatch.schedule(deadline: .now() + 1, repeating: 1)
stateWatch.setEventHandler {
    if let state = (device.value(forKey: "state") as? NSNumber)?.intValue, shutdownStates.contains(state) { exit(0) }
    tellHeld()
}
stateWatch.resume()

// Input runs in order on its queue, reading on its own; stdin ends when Cavvy goes, and so does the helper.
DispatchQueue.global().async {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8), let c = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        (queues[c["op"] as? String ?? ""] ?? inputQueue).async {
            var reply: [String: Any]
            do {
                reply = try handle(c)
                if reply.isEmpty { return }
            } catch let e as HelperError {
                reply = ["error": e.message]
            } catch {
                reply = ["error": "\(error)"]
            }
            reply["id"] = c["id"] ?? 0
            emitJSON(reply)
        }
    }
    exit(0)
}

dispatchMain()
