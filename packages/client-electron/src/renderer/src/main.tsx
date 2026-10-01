import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(<h1>ADT 单体客户端</h1>);
}
