export type Platform = "mac" | "windows" | "ios" | "android" | "other";

export function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Mac/.test(ua)) return "mac";
  if (/Windows/.test(ua)) return "windows";
  return "other";
}

export const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export const PLATFORM_NAME = { mac: "Mac", windows: "Windows" } as const;
