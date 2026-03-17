declare module "hoodiecrow-imap" {
  import type { Server } from "net";

  interface HoodiecrowMessage {
    raw: string;
    flags?: string[];
    internaldate?: string;
  }

  interface HoodiecrowFolder {
    messages?: HoodiecrowMessage[];
    folders?: Record<string, HoodiecrowFolder>;
    flags?: string[];
    "special-use"?: string;
    separator?: string;
  }

  interface HoodiecrowOptions {
    plugins?: string[];
    storage?: Record<string, HoodiecrowFolder>;
    users?: Record<string, { password: string }>;
    debug?: boolean;
    smtpPort?: number;
  }

  interface HoodiecrowServer extends Server {
    close(callback?: () => void): this;
  }

  function hoodiecrow(options?: HoodiecrowOptions): HoodiecrowServer;
  export = hoodiecrow;
}
