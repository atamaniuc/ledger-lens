import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Traces the server's real imports into .next/standalone, which is what the
  // Dockerfile's runtime stage copies. Without it the image would need the
  // whole node_modules tree. No effect on `bun run dev`.
  output: "standalone",
};

export default nextConfig;
