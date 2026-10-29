// Removes the temporary directories a test file made, after its own
// afterAll hooks have closed whatever still used them.
import { afterAll } from "vitest";
import { removeTempDirs } from "./tmp.js";

afterAll(removeTempDirs);
