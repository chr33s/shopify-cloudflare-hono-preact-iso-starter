import { hydrate } from "preact-iso";
import { App } from "./app.tsx";

hydrate(<App />, document.getElementById("app")!);
