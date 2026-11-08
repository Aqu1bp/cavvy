//! cavvy-native: one process the server starts once, that every session's turn snapshots read Git objects through.
//!
//! Without it, each session keeps a `git cat-file --batch` of its own (about 5 MB each, 30 of them with 30 sessions)
//! and starts a `git cat-file --batch-check` for each lookup. Here, one process answers them all, on a few threads,
//! from object stores opened once and kept (their pack indexes mapped once, not once per session).
//!
//! Requests, one JSON object a line on stdin:
//!   {"id": 1, "op": "read",   "objects": "<dir>", "alternates": ["<dir>", ...], "hash": "sha1", "oids": ["<hex>", ...]}
//!   {"id": 2, "op": "header", ...the same...}
//!   {"id": 3, "op": "ping"}
//! An object is looked for in `objects` first, then in each of `alternates`, as Git does with
//! GIT_OBJECT_DIRECTORY and GIT_ALTERNATE_OBJECT_DIRECTORIES (each store's own info/alternates too).
//!
//! Replies on stdout, in whatever order they're ready: u32 id, u32 length (little-endian), then that many bytes:
//!   0, then for each oid in order: read: u8 kind, u32 size, the bytes; header: u8 kind, u64 size
//!   1, then an error message (UTF-8)
//! kind: 0 missing, 1 commit, 2 tree, 3 blob, 4 tag. Nothing is written, fetched or run: reads only.

use std::collections::HashMap;
use std::io::{BufRead, BufWriter, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use gix_odb::{
    store::{
        init::{Options, Slots},
        RefreshMode,
    },
    Header as _, HandleArc, Store,
};
use gix_object::{Find as _, Kind};
use serde::Deserialize;

#[derive(Deserialize)]
struct Request {
    id: u32,
    op: String,
    #[serde(default)]
    objects: String,
    #[serde(default)]
    alternates: Vec<String>,
    #[serde(default)]
    hash: Option<String>,
    #[serde(default)]
    oids: Vec<String>,
}

/// Stores kept open past this many are let go (the least recently used first).
const MAX_STORES: usize = 64;
/// No single object larger than this is read (a snapshot never stores one; a huge blob would only cost memory).
const MAX_OBJECT_BYTES: u64 = 512 * 1024 * 1024;

type StoreKey = (PathBuf, gix_hash::Kind);

/// Each store open, with when it was last used (a count of uses), and that count.
type Open = (HashMap<StoreKey, (Arc<Store>, u64)>, u64);

/// Every store opened, shared by the threads; each thread keeps its own handle (with its own caches) to each.
struct Stores {
    open: Mutex<Open>,
}

impl Stores {
    fn get(&self, key: &StoreKey) -> std::io::Result<Arc<Store>> {
        let mut guard = self.open.lock().unwrap();
        let (map, clock) = &mut *guard;
        *clock += 1;
        let now = *clock;
        if let Some((s, used)) = map.get_mut(key) {
            *used = now;
            return Ok(s.clone());
        }
        // Room for twice the packs there are now: a session's store gains one each time a turn writes a lot, and a store
        // runs out of room, not slower, past what it was opened with; then it's opened again (forget), sized anew. Each
        // slot costs memory, so not more than that.
        let options = Options { slots: Slots::AsNeededByDiskState { multiplier: 2.0, minimum: 32 }, ..Options::default() };
        let store = Arc::new(Store::at_opts(key.0.clone(), key.1, &mut std::iter::empty(), options)?);
        if map.len() >= MAX_STORES {
            if let Some(oldest) = map.iter().min_by_key(|(_, (_, u))| *u).map(|(k, _)| k.clone()) {
                map.remove(&oldest);
            }
        }
        map.insert(key.clone(), (store.clone(), now));
        Ok(store)
    }
}

impl Stores {
    /// Let a store go, so the next use opens it again (sized to what's on disk then).
    fn forget(&self, key: &StoreKey) {
        self.open.lock().unwrap().0.remove(key);
    }
}

/// A thread's handles, by store; dropped with the store's entry when there are too many.
struct Handles {
    by_key: HashMap<StoreKey, (Arc<Store>, HandleArc)>,
}

impl Handles {
    fn handle(&mut self, stores: &Stores, key: &StoreKey) -> std::io::Result<&mut HandleArc> {
        let store = stores.get(key)?;
        let stale = self.by_key.get(key).is_some_and(|(s, _)| !Arc::ptr_eq(s, &store));
        if stale || !self.by_key.contains_key(key) {
            if self.by_key.len() >= MAX_STORES {
                self.by_key.clear();
            }
            let handle = store.to_cache_arc();
            self.by_key.insert(key.clone(), (store, handle));
        }
        Ok(&mut self.by_key.get_mut(key).unwrap().1)
    }
}

fn kind_code(k: Kind) -> u8 {
    match k {
        Kind::Commit => 1,
        Kind::Tree => 2,
        Kind::Blob => 3,
        Kind::Tag => 4,
    }
}

/// One object, as found: its kind and size (header), or its kind and bytes (read).
enum Found {
    Header(u8, u64),
    Body(u8, Vec<u8>),
}

/// The object in this store, if it's there.
fn find(h: &HandleArc, id: &gix_hash::oid, header_only: bool, buf: &mut Vec<u8>) -> Result<Option<Found>, String> {
    let Some(hd) = h.try_header(id).map_err(|e| e.to_string())? else { return Ok(None) };
    if header_only {
        return Ok(Some(Found::Header(kind_code(hd.kind()), hd.size())));
    }
    if hd.size() > MAX_OBJECT_BYTES {
        return Err(format!("object {id} is too large to read"));
    }
    Ok(h.try_find(id, buf).map_err(|e| e.to_string())?.map(|data| Found::Body(kind_code(data.kind), data.data.to_vec())))
}

fn answer(req: &Request, stores: &Stores, handles: &mut Handles) -> Result<Vec<u8>, String> {
    let hash = match req.hash.as_deref().unwrap_or("sha1") {
        "sha1" => gix_hash::Kind::Sha1,
        "sha256" => gix_hash::Kind::Sha256,
        other => return Err(format!("unknown object format {other}")),
    };
    if req.objects.is_empty() {
        return Err("no object directory".into());
    }
    let keys: Vec<StoreKey> = std::iter::once(&req.objects)
        .chain(req.alternates.iter().filter(|a| !a.is_empty()))
        .map(|d| (PathBuf::from(d), hash))
        .collect();
    let mut ids = Vec::with_capacity(req.oids.len());
    for hex in &req.oids {
        let id = gix_hash::ObjectId::from_hex(hex.as_bytes()).map_err(|e| format!("bad object id {hex}: {e}"))?;
        if id.kind() != hash {
            return Err(format!("object id {hex} isn't {:?}", hash));
        }
        ids.push(id);
    }
    let header_only = req.op == "header";
    let mut found: Vec<Option<Found>> = (0..ids.len()).map(|_| None).collect();
    let mut buf = Vec::new();
    // Every store as it's known first; then, for what none of them had, each looks at its folder again for packs
    // written since. Looking again for each miss costs a scan of the folder: the session's own store misses every
    // object that's only in the repository's.
    for refresh in [RefreshMode::Never, RefreshMode::AfterAllIndicesLoaded] {
        for key in &keys {
            if found.iter().all(Option::is_some) {
                break;
            }
            for (i, id) in ids.iter().enumerate() {
                if found[i].is_some() {
                    continue;
                }
                let mut attempt = 0;
                // A store that can't be opened (a folder gone) has nothing: as git, the next one is asked.
                while let Ok(h) = handles.handle(stores, key) {
                    h.refresh = refresh;
                    match find(h, id, header_only, &mut buf) {
                        Ok(f) => {
                            found[i] = f;
                            break;
                        }
                        // More packs than the store was opened with room for: opened again, once.
                        Err(e) if attempt == 0 && e.contains("too few index slots") => {
                            stores.forget(key);
                            handles.by_key.remove(key);
                            attempt += 1;
                        }
                        Err(e) => return Err(e),
                    }
                }
            }
        }
    }
    let mut out = vec![0u8];
    for f in found {
        match f {
            Some(Found::Header(kind, size)) => {
                out.push(kind);
                out.extend_from_slice(&size.to_le_bytes());
            }
            Some(Found::Body(kind, data)) => {
                out.push(kind);
                out.extend_from_slice(&(data.len() as u32).to_le_bytes());
                out.extend_from_slice(&data);
            }
            None => {
                out.push(0);
                if header_only {
                    out.extend_from_slice(&0u64.to_le_bytes());
                } else {
                    out.extend_from_slice(&0u32.to_le_bytes());
                }
            }
        }
        // The reply's length is 32 bits.
        if out.len() > u32::MAX as usize {
            return Err("the objects asked for are too large to send at once".into());
        }
    }
    Ok(out)
}

fn frame(id: u32, body: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(8 + body.len());
    f.extend_from_slice(&id.to_le_bytes());
    f.extend_from_slice(&(body.len() as u32).to_le_bytes());
    f.extend_from_slice(body);
    f
}

fn error(id: u32, msg: &str) -> Vec<u8> {
    let mut b = vec![1u8];
    b.extend_from_slice(msg.as_bytes());
    frame(id, &b)
}

fn main() {
    let threads = std::env::var("CAVVY_NATIVE_THREADS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get().min(4)).unwrap_or(2));
    let stores = Arc::new(Stores { open: Mutex::new((HashMap::new(), 0)) });
    let (jobs_tx, jobs_rx) = mpsc::channel::<Request>();
    let jobs_rx = Arc::new(Mutex::new(jobs_rx));
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();

    // One writer: frames go out whole, and are flushed once nothing more is waiting.
    let writer = std::thread::spawn(move || {
        let stdout = std::io::stdout();
        let mut w = BufWriter::with_capacity(256 * 1024, stdout.lock());
        while let Ok(f) = out_rx.recv() {
            if w.write_all(&f).is_err() {
                return;
            }
            while let Ok(more) = out_rx.try_recv() {
                if w.write_all(&more).is_err() {
                    return;
                }
            }
            if w.flush().is_err() {
                return;
            }
        }
    });

    let mut workers = Vec::new();
    for _ in 0..threads {
        let rx = jobs_rx.clone();
        let tx = out_tx.clone();
        let stores = stores.clone();
        workers.push(std::thread::spawn(move || {
            let mut handles = Handles { by_key: HashMap::new() };
            loop {
                let job = { rx.lock().unwrap().recv() };
                let Ok(req) = job else { return };
                let f = match answer(&req, &stores, &mut handles) {
                    Ok(body) => frame(req.id, &body),
                    Err(e) => error(req.id, &e),
                };
                if tx.send(f).is_err() {
                    return;
                }
            }
        }));
    }

    let stdin = std::io::stdin();
    let mut line = Vec::new();
    let mut input = stdin.lock();
    loop {
        line.clear();
        match input.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if line.iter().all(|b| b.is_ascii_whitespace()) {
            continue;
        }
        let req: Request = match serde_json::from_slice(&line) {
            Ok(r) => r,
            Err(e) => {
                // Without an id there's no one to answer; one with a readable id gets the error.
                let id = serde_json::from_slice::<serde_json::Value>(&line).ok().and_then(|v| v.get("id")?.as_u64()).unwrap_or(0) as u32;
                let _ = out_tx.send(error(id, &format!("bad request: {e}")));
                continue;
            }
        };
        if req.op == "ping" {
            let _ = out_tx.send(frame(req.id, &[0u8]));
            continue;
        }
        if req.op != "read" && req.op != "header" {
            let _ = out_tx.send(error(req.id, &format!("unknown op {}", req.op)));
            continue;
        }
        if jobs_tx.send(req).is_err() {
            break;
        }
    }
    drop(jobs_tx);
    for w in workers {
        let _ = w.join();
    }
    drop(out_tx);
    let _ = writer.join();
}
