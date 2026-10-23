// Object URLs with more than one user (gui/src/lib/object-urls.ts): a reply's
// image URLs are revoked when the reply goes, unless the image viewer still
// shows them; then when it closes.

import { describe, expect, test } from "bun:test";
import { UrlLeases } from "../gui/src/lib/object-urls";

const leases = () => {
    const revoked: string[] = [];
    return { revoked, urls: new UrlLeases((u) => revoked.push(u)) };
};

describe("UrlLeases", () => {
    test("dropped with nothing holding it: revoked at once", () => {
        const { revoked, urls } = leases();
        urls.drop("blob:a");
        expect(revoked).toEqual(["blob:a"]);
    });

    test("dropped while held: revoked when the hold ends, not before", () => {
        const { revoked, urls } = leases();
        const release = urls.hold(["blob:a", "blob:b"]);
        urls.drop("blob:a");
        expect(revoked).toEqual([]);
        release();
        expect(revoked).toEqual(["blob:a"]);
    });

    test("held, never dropped: its owner still has it after the hold ends", () => {
        const { revoked, urls } = leases();
        urls.hold(["blob:a"])();
        expect(revoked).toEqual([]);
        urls.drop("blob:a");
        expect(revoked).toEqual(["blob:a"]);
    });

    test("two holds: revoked when the last one ends", () => {
        const { revoked, urls } = leases();
        const one = urls.hold(["blob:a"]);
        const two = urls.hold(["blob:a"]);
        urls.drop("blob:a");
        one();
        expect(revoked).toEqual([]);
        two();
        expect(revoked).toEqual(["blob:a"]);
    });

    test("releasing twice, or holding a URL twice in one hold, counts once", () => {
        const { revoked, urls } = leases();
        const other = urls.hold(["blob:a"]);
        const release = urls.hold(["blob:a", "blob:a"]);
        urls.drop("blob:a");
        release();
        release();
        expect(revoked).toEqual([]);
        other();
        expect(revoked).toEqual(["blob:a"]);
    });
});
