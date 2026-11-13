// Twins a world file can name under `twins:` (host → twin).
import type { TwinFactory } from "../host/world.ts";
import { clerk } from "./clerk.ts";
import { retell } from "./retell.ts";
import { sink } from "./sink.ts";
import { stripe } from "./stripe.ts";

export const TWINS: Record<string, TwinFactory> = { clerk, retell, stripe, sink };
