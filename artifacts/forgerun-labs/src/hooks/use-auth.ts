import { useState, useEffect } from "react";

export function useAuthToken() {
  const [token, setTokenState] = useState<string>("");
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("forgerun_admin_token");
    if (stored) setTokenState(stored);
    setIsLoaded(true);
  }, []);

  const setToken = (newToken: string) => {
    if (newToken) {
      localStorage.setItem("forgerun_admin_token", newToken);
    } else {
      localStorage.removeItem("forgerun_admin_token");
    }
    setTokenState(newToken);
  };

  const logout = () => setToken("");

  return { token, setToken, logout, isLoaded };
}
