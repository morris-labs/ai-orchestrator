import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// The workspace runs every package's tests at once; give findBy and waitFor
// room for a slow first render under that load.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  window.location.hash = "";
});
