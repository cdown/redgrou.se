import type { NextConfig } from "next";
import { execSync } from "child_process";

function getGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_VERSION: getGitSha(),
  },
};

export default nextConfig;
