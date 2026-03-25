import * as React from "react";
import { motion } from "framer-motion";
import { ExternalLink, ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Project } from "@workspace/api-client-react";

interface ProjectCardProps {
  project: Project;
  index: number;
}

export function ProjectCard({ project, index }: ProjectCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: index * 0.1, ease: [0.23, 1, 0.32, 1] }}
      className="group"
    >
      <a 
        href={project.url} 
        target="_blank" 
        rel="noopener noreferrer"
        className="block h-full"
      >
        <div className="glass-panel relative flex h-full flex-col rounded-2xl p-6 transition-all duration-500 hover:-translate-y-2 hover:shadow-[0_20px_40px_rgba(0,0,0,0.4)] hover:border-primary/30">
          
          {/* Subtle gradient hover effect */}
          <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-primary/5 to-accent/5 opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
          
          <div className="relative z-10 flex items-start justify-between mb-4">
            <div className="flex items-center gap-3">
              <Badge status={project.status}>{project.status}</Badge>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary/50 text-muted-foreground backdrop-blur-md transition-all duration-300 group-hover:bg-primary group-hover:text-primary-foreground group-hover:scale-110">
              <ArrowUpRight className="h-5 w-5" />
            </div>
          </div>

          <div className="relative z-10 flex-1">
            <h3 className="font-display text-2xl font-bold text-white mb-2 group-hover:text-primary transition-colors">
              {project.name}
            </h3>
            <p className="text-muted-foreground leading-relaxed line-clamp-3">
              {project.description}
            </p>
          </div>

          <div className="relative z-10 mt-6 flex items-center text-sm font-medium text-muted-foreground transition-colors group-hover:text-white">
            <ExternalLink className="mr-2 h-4 w-4 opacity-50" />
            <span className="truncate">{project.url.replace(/^https?:\/\//, '')}</span>
          </div>
        </div>
      </a>
    </motion.div>
  );
}
