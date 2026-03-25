import * as React from "react";
import { Link, useLocation } from "wouter";
import { motion } from "framer-motion";
import { Database, LayoutDashboard, ShieldAlert } from "lucide-react";
import { useAuthToken } from "@/hooks/use-auth";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { token, logout } = useAuthToken();
  const isAdmin = location.startsWith("/admin");

  return (
    <div className="flex min-h-screen flex-col relative overflow-hidden">
      {/* Dynamic Background */}
      <div className="absolute inset-0 -z-10 opacity-20 pointer-events-none">
        <img 
          src={`${import.meta.env.BASE_URL}images/hero-mesh.png`} 
          alt="" 
          className="w-full h-[80vh] object-cover object-top mix-blend-screen mask-image-b"
          style={{ WebkitMaskImage: 'linear-gradient(to bottom, black 0%, transparent 100%)' }}
        />
      </div>

      <header className="sticky top-0 z-40 w-full border-b border-white/5 bg-background/60 backdrop-blur-xl">
        <div className="mx-auto flex h-20 max-w-7xl items-center justify-between px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-3 group">
            <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-secondary border border-white/10 overflow-hidden group-hover:border-primary/50 transition-colors">
              <img src={`${import.meta.env.BASE_URL}images/logo-mark.png`} alt="Logo" className="w-6 h-6 z-10" />
              <div className="absolute inset-0 bg-primary/20 blur-xl group-hover:bg-primary/40 transition-colors" />
            </div>
            <div>
              <h1 className="font-display text-lg font-bold tracking-tight text-white group-hover:text-primary transition-colors">
                ForgeRun <span className="font-light text-muted-foreground">Labs</span>
              </h1>
            </div>
          </Link>

          <nav className="flex items-center gap-4">
            {isAdmin && token && (
              <button 
                onClick={logout}
                className="text-sm font-medium text-muted-foreground hover:text-white transition-colors"
              >
                Sign Out
              </button>
            )}
            <Link 
              href={isAdmin ? "/" : "/admin"} 
              className="inline-flex h-10 items-center justify-center rounded-lg bg-white/5 px-4 text-sm font-medium text-white transition-colors hover:bg-white/10 hover:text-primary"
            >
              {isAdmin ? (
                <>
                  <LayoutDashboard className="mr-2 h-4 w-4" />
                  Public Showcase
                </>
              ) : (
                <>
                  <ShieldAlert className="mr-2 h-4 w-4" />
                  Admin Console
                </>
              )}
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1 w-full max-w-7xl mx-auto px-6 lg:px-8 py-12 lg:py-20">
        {children}
      </main>

      <footer className="mt-auto border-t border-white/5 bg-background py-8">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-6 md:flex-row lg:px-8">
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} Royal Ohio Holdings. All rights reserved.
          </p>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Database className="h-4 w-4 text-primary" />
            <span>Systems Operational</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
