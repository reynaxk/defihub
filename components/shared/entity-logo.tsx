"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

export function EntityLogo({
  src,
  name,
  size = 24,
  className,
}: {
  src: string | null;
  name: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground",
          className,
        )}
        style={{ width: size, height: size }}
      >
        {name.slice(0, 1).toUpperCase()}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- logos come from an
    // external, only-loosely-controlled provider; next/image's optimizer
    // errors hard on the 404s that are routine here.
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={cn("shrink-0 rounded-full bg-muted object-cover", className)}
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  );
}
