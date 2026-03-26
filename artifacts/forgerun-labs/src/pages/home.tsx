import * as React from "react";
import { motion } from "framer-motion";
import { Layout } from "@/components/layout";
import { ProjectCard } from "@/components/project-card";
import { useListPublicProjects } from "@workspace/api-client-react";
import { Loader2, ServerCrash } from "lucide-react";

export default function Home() {
  const { data: projects, isLoading, isError } = useListPublicProjects();

  return (
    <Layout>
      <div className="flex flex-col items-center text-center mb-20 lg:mb-32">
        <motion.a
          href="https://royalohioholdings.com/"
          target="_blank"
          rel="noopener noreferrer"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.7, ease: "easeOut" }}
          className="inline-flex items-center rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 text-sm font-medium text-primary mb-8 hover:bg-primary/10 transition-colors"
        >
          <span className="relative flex h-2 w-2 mr-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
          </span>
          Royal Ohio Holdings
        </motion.a>
        
        <motion.h1 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.1, ease: "easeOut" }}
          className="font-display text-5xl sm:text-6xl lg:text-7xl font-extrabold tracking-tight text-white mb-6"
        >
          Build. <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-accent">Launch.</span> Showcase.
        </motion.h1>
        
        <motion.p 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.2, ease: "easeOut" }}
          className="max-w-2xl text-lg sm:text-xl text-muted-foreground"
        >
          The central registry and command center for all active developments, 
          experiments, and production systems running under ForgeRun Labs.
        </motion.p>
      </div>

      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-20 text-primary">
          <Loader2 className="h-12 w-12 animate-spin mb-4" />
          <p className="text-muted-foreground font-medium animate-pulse">Establishing uplink...</p>
        </div>
      ) : isError ? (
        <div className="glass-panel flex flex-col items-center justify-center py-20 rounded-2xl border-destructive/20 bg-destructive/5 text-center">
          <ServerCrash className="h-16 w-16 text-destructive mb-4" />
          <h3 className="text-xl font-bold text-white mb-2">Systems Offline</h3>
          <p className="text-muted-foreground">Unable to connect to the project registry. Please try again later.</p>
        </div>
      ) : !projects || projects.length === 0 ? (
        <div className="glass-panel flex flex-col items-center justify-center py-20 rounded-2xl text-center">
          <div className="h-16 w-16 rounded-full bg-secondary flex items-center justify-center mb-4">
            <span className="text-2xl">🚀</span>
          </div>
          <h3 className="text-xl font-bold text-white mb-2">No Projects Deployed</h3>
          <p className="text-muted-foreground">The lab is currently quiet. New builds incoming.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-8">
          {projects.map((project, idx) => (
            <ProjectCard key={project.id} project={project} index={idx} />
          ))}
        </div>
      )}
    </Layout>
  );
}
