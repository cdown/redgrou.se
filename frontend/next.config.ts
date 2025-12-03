import type { NextConfig } from "next";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

function getGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
}

function getBuildDate(): string {
  try {
    return execSync("date -u '+%Y-%m-%d %H:%M:%S UTC'").toString().trim();
  } catch {
    return "unknown";
  }
}

function getNextJsVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, "package.json"), "utf-8")
    );
    return packageJson.dependencies.next || "unknown";
  } catch {
    return "unknown";
  }
}

function getNodeVersion(): string {
  try {
    return process.version;
  } catch {
    return "unknown";
  }
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_VERSION: getGitSha(),
    NEXT_PUBLIC_BUILD_DATE: getBuildDate(),
    NEXT_PUBLIC_NEXTJS_VERSION: getNextJsVersion(),
    NEXT_PUBLIC_NODE_VERSION: getNodeVersion(),
  },
};

export default nextConfig;
