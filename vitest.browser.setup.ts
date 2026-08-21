// Design tokens, into the test page. Axe's colour-contrast rule can only
// judge colours it can see, and a panel rendered against an unstyled page
// would fail (or pass) for reasons that have nothing to do with the
// component. This is the same stylesheet the app ships — one import, one
// source of truth.
import "./src/app/globals.css";

// This project runs without "globals: true", so testing-library cannot
// auto-register its afterEach cleanup — without it every render leaks into
// the next test's document ("found multiple elements").
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
