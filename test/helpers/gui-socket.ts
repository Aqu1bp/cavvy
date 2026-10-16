// A controllable transport boundary; requests still go through the real Rpc.

export class Socket {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = 0;
    sent: { id: number; method: string }[] = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number }) => void;
    constructor() {
        Socket.instances.push(this);
    }

    open() {
        this.readyState = 1;
        this.onopen?.();
    }

    send(raw: string) {
        this.sent.push(JSON.parse(raw));
    }

    message(msg: unknown) {
        this.onmessage?.({ data: JSON.stringify(msg) });
    }

    close() {
        this.readyState = 3;
        this.onclose?.({ code: 1006 });
    }
}
