/**
 * Entry point. This page runs in a WebView inside the Even Realities app on
 * the phone; the glasses are its second screen, reached through the SDK bridge.
 */
import { waitForEvenAppBridge, type EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { isLang, langFromTag } from "../shared/i18n.ts";
import { Api, type Storage } from "./api.ts";
import { App } from "./app.ts";
import { mountPhone, showOutsideEven } from "./phone/ui.ts";

/**
 * Small things to remember between launches (the device token, the language).
 * The Even app's own storage survives reinstalls of the WebView cache; the
 * browser's localStorage is kept in step as a second copy.
 */
function storageFor(bridge: EvenAppBridge): Storage {
  const local = {
    get: (key: string) => {
      try {
        return window.localStorage.getItem(key) ?? "";
      } catch {
        return "";
      }
    },
    set: (key: string, value: string) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // private mode: the bridge copy is enough
      }
    },
  };
  return {
    async get(key) {
      try {
        const value = await bridge.getLocalStorage(key);
        if (value) return value;
      } catch {
        // fall back to the browser copy
      }
      return local.get(key);
    },
    async set(key, value) {
      local.set(key, value);
      try {
        await bridge.setLocalStorage(key, value);
      } catch {
        // the browser copy is enough
      }
    },
  };
}

// The SDK prints every event it receives, including ten microphone frames a second.
// Keep those out of the console so the lines that matter can be read.
const log = console.log.bind(console);
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("EvenHub event") && args.join(" ").includes("audioPcm")) return;
  log(...args);
};

// Outside the Even app there is no bridge and this would wait forever: say so instead of showing a blank page.
const hint = window.setTimeout(showOutsideEven, 2500);
const bridge = await waitForEvenAppBridge();
window.clearTimeout(hint);

const storage = storageFor(bridge);
// The language: ?lang=zh in the address (handy for demos), then what was chosen before, then the phone's language.
const asked = new URLSearchParams(location.search).get("lang");
const saved = await storage.get("chengzhang.lang");
const lang = isLang(asked) ? asked : isLang(saved) ? saved : langFromTag(navigator.language);
const api = new Api(storage, lang);
const app = new App(bridge, api, storage, lang);

bridge.onEvenHubEvent((event) => app.onEvent(event));
mountPhone(app, storage);
await app.start();
