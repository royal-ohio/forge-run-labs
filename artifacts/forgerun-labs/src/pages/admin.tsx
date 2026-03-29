import * as React from "react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Edit2, Trash2, KeyRound, Lock, Search, AlertCircle, Loader2 } from "lucide-react";
import { motion } from "framer-motion";

import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { useAuthToken } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";

import {
  useListAllProjects,
  useCreateProject,
  useUpdateProject,
  useDeleteProject,
  getListAllProjectsQueryKey,
  getListPublicProjectsQueryKey,
  ProjectStatus,
  type Project
} from "@workspace/api-client-react";

// --- Validation Schemas ---
const projectSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().min(1, "Description is required"),
  url: z.string().url("Must be a valid URL"),
  status: z.enum([ProjectStatus.LIVE, ProjectStatus.BUILDING, ProjectStatus.OFFLINE]),
  isPublic: z.boolean().default(true),
  sortOrder: z.coerce.number().default(0),
});

type ProjectFormData = z.infer<typeof projectSchema>;

// --- Components ---

function AdminLogin() {
  const { setToken } = useAuthToken();
  const [input, setInput] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) setToken(input.trim());
  };

  return (
    <div className="flex flex-col items-center justify-center py-20">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass-panel w-full max-w-md rounded-2xl p-8 text-center relative overflow-hidden"
      >
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary via-accent to-primary" />
        
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-secondary border border-border shadow-inner">
          <Lock className="h-8 w-8 text-primary" />
        </div>
        
        <h2 className="font-display text-2xl font-bold text-white mb-2">Restricted Access</h2>
        <p className="text-muted-foreground mb-8">
          Enter your clearance token to access the ForgeRun Labs administration console.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative">
            <KeyRound className="absolute left-4 top-3.5 h-5 w-5 text-muted-foreground" />
            <Input 
              type="password"
              placeholder="Admin Token"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="pl-12 font-mono text-center tracking-widest"
              autoFocus
            />
          </div>
          <Button type="submit" className="w-full" size="lg">
            Initialize Uplink
          </Button>
        </form>
      </motion.div>
    </div>
  );
}

export default function Admin() {
  const { token, isLoaded } = useAuthToken();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);

  // Queries
  const { data: projects, isLoading, isError, error } = useListAllProjects({
    query: { enabled: !!token },
    request: { headers: { "x-admin-token": token } }
  });

  // Mutations
  const createMutation = useCreateProject({
    request: { headers: { "x-admin-token": token } },
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAllProjectsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListPublicProjectsQueryKey() });
        toast({ title: "Project deployed", description: "Successfully added to the registry." });
        handleCloseModal();
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Deployment failed", description: err.message || "Unknown error" });
      }
    }
  });

  const updateMutation = useUpdateProject({
    request: { headers: { "x-admin-token": token } },
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAllProjectsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListPublicProjectsQueryKey() });
        toast({ title: "Project updated", description: "Registry data synchronized." });
        handleCloseModal();
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Update failed", description: err.message || "Unknown error" });
      }
    }
  });

  const deleteMutation = useDeleteProject({
    request: { headers: { "x-admin-token": token } },
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAllProjectsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListPublicProjectsQueryKey() });
        toast({ title: "Project terminated", description: "Successfully removed from registry." });
        setProjectToDelete(null);
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Termination failed", description: err.message || "Unknown error" });
      }
    }
  });

  // Form Setup
  const form = useForm<ProjectFormData>({
    resolver: zodResolver(projectSchema),
    defaultValues: {
      name: "", description: "", url: "", status: "BUILDING", isPublic: true, sortOrder: 0
    }
  });

  const handleOpenModal = (project?: Project) => {
    if (project) {
      setEditingProject(project);
      form.reset({
        name: project.name,
        description: project.description,
        url: project.url,
        status: project.status,
        isPublic: project.isPublic,
        sortOrder: project.sortOrder
      });
    } else {
      setEditingProject(null);
      form.reset({
        name: "", description: "", url: "https://", status: "BUILDING", isPublic: true, sortOrder: 0
      });
    }
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setTimeout(() => {
      setEditingProject(null);
      form.reset();
    }, 200);
  };

  const onSubmit = (data: ProjectFormData) => {
    if (editingProject) {
      updateMutation.mutate({ id: editingProject.id, data });
    } else {
      createMutation.mutate({ data });
    }
  };

  // Render logic
  if (!isLoaded) return null;

  return (
    <Layout>
      {!token ? (
        <AdminLogin />
      ) : (
        <div className="space-y-8">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h1 className="font-display text-3xl font-bold text-white">Registry Command</h1>
              <p className="text-muted-foreground mt-1">Manage ForgeRun Labs deployments</p>
            </div>
            <Button onClick={() => handleOpenModal()} className="sm:w-auto w-full group">
              <Plus className="mr-2 h-5 w-5 transition-transform group-hover:rotate-90" />
              New Deployment
            </Button>
          </div>

          {/* Error State */}
          {isError && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-6 flex items-start gap-4">
              <AlertCircle className="h-6 w-6 text-destructive shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-destructive">Authorization Error</h3>
                <p className="text-sm text-destructive/80 mt-1">
                  {(error as any)?.message || "Your token is invalid or expired. Please sign out and try again."}
                </p>
              </div>
            </div>
          )}

          {/* Data Table */}
          <div className="glass-panel rounded-2xl overflow-hidden border border-border">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs uppercase bg-secondary/80 text-muted-foreground border-b border-border">
                  <tr>
                    <th className="px-6 py-4 font-medium">Project</th>
                    <th className="px-6 py-4 font-medium">Status</th>
                    <th className="px-6 py-4 font-medium">Visibility</th>
                    <th className="px-6 py-4 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {isLoading ? (
                    <tr>
                      <td colSpan={4} className="px-6 py-12 text-center text-muted-foreground">
                        <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2 text-primary" />
                        Fetching registry data...
                      </td>
                    </tr>
                  ) : projects?.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-6 py-12 text-center text-muted-foreground">
                        No projects found. Deploy your first system.
                      </td>
                    </tr>
                  ) : (
                    projects?.map((project) => (
                      <tr key={project.id} className="hover:bg-white/[0.02] transition-colors">
                        <td className="px-6 py-4">
                          <div className="font-bold text-white">{project.name}</div>
                          <div className="text-muted-foreground text-xs truncate max-w-xs mt-1">
                            {project.url}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <Badge status={project.status}>{project.status}</Badge>
                        </td>
                        <td className="px-6 py-4">
                          {project.isPublic ? (
                            <span className="inline-flex items-center text-primary bg-primary/10 px-2 py-1 rounded text-xs font-medium border border-primary/20">
                              Public
                            </span>
                          ) : (
                            <span className="inline-flex items-center text-muted-foreground bg-secondary px-2 py-1 rounded text-xs font-medium border border-border">
                              Private
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button 
                              variant="ghost" 
                              size="icon"
                              onClick={() => handleOpenModal(project)}
                              className="h-8 w-8 text-muted-foreground hover:text-white"
                            >
                              <Edit2 className="h-4 w-4" />
                            </Button>
                            <Button 
                              variant="ghost" 
                              size="icon"
                              onClick={() => setProjectToDelete(project)}
                              className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Create/Edit Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        title={editingProject ? "Configure Deployment" : "Initialize Deployment"}
        description={editingProject ? `Modifying parameters for ${editingProject.name}` : "Set parameters for new lab project."}
      >
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-white mb-1.5 block">Designation</label>
              <Input {...form.register("name")} placeholder="Project Name" />
              {form.formState.errors.name && <p className="text-xs text-destructive mt-1">{form.formState.errors.name.message}</p>}
            </div>

            <div>
              <label className="text-sm font-medium text-white mb-1.5 block">Description</label>
              <textarea 
                {...form.register("description")} 
                className="flex min-h-[100px] w-full rounded-xl border border-border bg-secondary/50 px-4 py-3 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:border-primary resize-none"
                placeholder="What does this system do?"
              />
              {form.formState.errors.description && <p className="text-xs text-destructive mt-1">{form.formState.errors.description.message}</p>}
            </div>

            <div>
              <label className="text-sm font-medium text-white mb-1.5 block">Target URL</label>
              <Input {...form.register("url")} placeholder="https://" />
              {form.formState.errors.url && <p className="text-xs text-destructive mt-1">{form.formState.errors.url.message}</p>}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-white mb-1.5 block">System Status</label>
                <select 
                  {...form.register("status")}
                  className="flex h-12 w-full rounded-xl border border-border bg-secondary/50 px-4 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:border-primary appearance-none"
                >
                  <option value="LIVE">LIVE</option>
                  <option value="BUILDING">BUILDING</option>
                  <option value="OFFLINE">OFFLINE</option>
                </select>
              </div>
              
              <div>
                <label className="text-sm font-medium text-white mb-1.5 block">Sort Index</label>
                <Input type="number" {...form.register("sortOrder")} placeholder="0" />
              </div>
            </div>

            <div className="flex items-center justify-between p-4 rounded-xl border border-border bg-secondary/30 mt-2">
              <div>
                <div className="font-medium text-white text-sm">Public Visibility</div>
                <div className="text-xs text-muted-foreground mt-0.5">Show on the main registry page</div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" {...form.register("isPublic")} className="sr-only peer" />
                <div className="w-11 h-6 bg-secondary peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-border mt-6">
            <Button type="button" variant="ghost" onClick={handleCloseModal}>Cancel</Button>
            <Button 
              type="submit" 
              isLoading={createMutation.isPending || updateMutation.isPending}
            >
              {editingProject ? "Apply Changes" : "Deploy System"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={!!projectToDelete}
        onClose={() => setProjectToDelete(null)}
        title="Confirm Termination"
        description="This action cannot be undone."
      >
        <div className="space-y-6">
          <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
            You are about to permanently delete <strong>{projectToDelete?.name}</strong> from the registry.
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setProjectToDelete(null)}>Cancel</Button>
            <Button 
              variant="destructive" 
              onClick={() => projectToDelete && deleteMutation.mutate({ id: projectToDelete.id })}
              isLoading={deleteMutation.isPending}
            >
              Terminate
            </Button>
          </div>
        </div>
      </Modal>
    </Layout>
  );
}
