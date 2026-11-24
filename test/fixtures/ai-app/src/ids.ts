import { z } from 'zod';
import { nanoId } from 'nanoid'; // real package, but not installed, not in package.json, and the export is "nanoid"

export const User = z.object({ id: z.string(), email: z.string() });
export const newId = () => nanoId();
