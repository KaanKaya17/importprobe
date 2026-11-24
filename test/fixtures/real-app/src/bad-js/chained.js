import * as z from 'zod';
import express from 'express';

export const email = z.string().emailAddress(); // invented: never declared in zod
const app = express();
app.listenAsync(3000); // invented: never declared in express typings
export const ok = z.string().min(1); // real
