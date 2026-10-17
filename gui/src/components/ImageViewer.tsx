import { setViewedImage, viewedImage } from "../state/ui";
import { Dialog } from "./ui/Dialog";

/** An image at full size; Escape or a click outside closes it. */
export function ImageViewer() {
    const close = () => setViewedImage(undefined);
    return (
        <Dialog open={Boolean(viewedImage())} onClose={close} bare class="image-viewer">
            <img src={viewedImage()?.src} alt={viewedImage()?.alt ?? ""} onClick={close} />
        </Dialog>
    );
}
