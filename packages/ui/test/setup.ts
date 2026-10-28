// Adds the jest-dom matchers, such as `toBeDisabled()`, to `expect`, and
// unmounts rendered trees after each test.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
