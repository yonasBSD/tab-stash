import type {Events} from "webextension-polyfill";

import type {Args} from "./index.js";

export type EventSource<L extends (...args: any[]) => any> = Events.Event<L>;

/** An event.  Events have listeners which are managed through the usual
 * add/has/removeListener() methods.  A message can be broadcast to all
 * listeners using the send() method. */
export interface Event<L extends (...args: any[]) => any>
  extends EventSource<L> {
  /** Send a message to all listeners.  send() will arrange for each listener
   * to be called with the arguments provided after send() returns. */
  send(...args: Args<L>): void;
}

let eventClass: {new (name: string, instance?: string): Event<any>};

/* c8 ignore start -- tests are always run in a mock environment */
if ((<any>globalThis).mock?.events) {
  // We are running in a mock environment.  Use the MockEventDispatcher
  // instead, which allows for snooping on events.
  eventClass = (<any>globalThis).MockEvent;
} else {
  eventClass = class Event<L extends (...args: any[]) => any>
    implements Event<L>
  {
    private _listeners: Set<L> = new Set();

    addListener(l: L) {
      this._listeners.add(l);
    }

    removeListener(l: L) {
      this._listeners.delete(l);
    }

    hasListener(l: L) {
      return this._listeners.has(l);
    }

    hasListeners() {
      return this._listeners.size > 0;
    }

    send(...args: Args<L>) {
      // This executes more quickly than setTimeout(), which is what we
      // want since setTimeout() is often used to wait for events to be
      // delivered (and immediate timeouts are not always run in the order
      // they are scheduled...).
      Promise.resolve().then(() => this.sendSync(...args));
    }

    private sendSync(...args: Args<L>) {
      for (const fn of this._listeners) {
        try {
          fn(...args);
        } catch (e) {
          console.error(e);
        }
      }
    }
  };
}
/* c8 ignore stop */

/** Constructs and returns an event.  In unit tests, this is a mock which must
 * be explicitly controlled by the calling test. */
export default function <L extends (...args: any[]) => any>(
  name: string,
  instance?: string,
): Event<L> {
  return new eventClass(name, instance);
}
