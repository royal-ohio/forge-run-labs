import * as React from "react";
import { cn } from "@/lib/utils";

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  status?: "LIVE" | "BUILDING" | "OFFLINE";
}

function Badge({ className, status, children, ...props }: BadgeProps) {
  const statusStyles = {
    LIVE: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20 shadow-[0_0_10px_rgba(16,185,129,0.15)]",
    BUILDING: "bg-amber-500/10 text-amber-400 border-amber-500/20 shadow-[0_0_10px_rgba(245,158,11,0.15)]",
    OFFLINE: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  };

  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide transition-colors",
        status ? statusStyles[status] : "bg-secondary text-secondary-foreground border-border",
        className
      )}
      {...props}
    >
      {status && (
        <span className={cn("mr-1.5 h-1.5 w-1.5 rounded-full animate-pulse", 
          status === "LIVE" ? "bg-emerald-400" : 
          status === "BUILDING" ? "bg-amber-400" : "bg-zinc-400"
        )} />
      )}
      {children}
    </div>
  );
}

export { Badge };
