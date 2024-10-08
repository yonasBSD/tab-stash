// This file is auto-loaded so that it mocks up various global browser
// facilities BEFORE tests are run, and resets/verifies sanity AFTER tests are
// complete.

import type {RootHookObject} from "mocha";

// Setup globals before importing, so that webextension-polyfill etc. see what
// they expect.
(<any>globalThis).mock = {
  indexedDB: true,
  browser: true,
  events: true,
};
(<any>globalThis).browser = {
  // Keep the polyfill happy
  runtime: {
    id: "mock",
  },
};
/* c8 ignore next 3 -- covering for differences in Node versions */
if (!(<any>globalThis).navigator) {
  (<any>globalThis).navigator = {hardwareConcurrency: 4};
}

// Keep the polyfill happy
(<any>globalThis).chrome = (<any>globalThis).browser;

// Mock indexedDB.* APIs
import "fake-indexeddb/auto";

// Mock WebExtension APIs
import * as events from "./events.js";

await import("webextension-polyfill");
const mock_browser = await import("./browser/index.js");

// Reset the mocks before each test, and make sure all events have drained after
// each test.
export const mochaHooks: RootHookObject = {
  beforeEach() {
    (<any>globalThis).indexedDB = new IDBFactory();
    events.beforeTest();
    mock_browser.runtime.reset();
    mock_browser.storage.reset();
    mock_browser.bookmarks.reset();
    mock_browser.tabs_and_windows.reset();
    mock_browser.sessions.reset();
    mock_browser.containers.reset();
  },
  async afterEach() {
    await events.afterTest();
  },
};
