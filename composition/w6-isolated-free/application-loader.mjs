import { installIsolatedFreeViewer } from "/w6-isolated-free.js?ot1=1";

installIsolatedFreeViewer(window);
await import("/viewer.js");
await import("/application-browser.js?ot1=1");