import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Root from "./Root.tsx";

import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
