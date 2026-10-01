import { createRoot } from "react-dom/client";

import { App } from "./app";
import { appClient } from "./api";

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(<App client={appClient()} />);
}
