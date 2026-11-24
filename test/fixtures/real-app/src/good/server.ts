import express, { type Request, type Response, Router } from 'express';
import _ from 'lodash';
import get from 'lodash/get';
import { debounce } from 'lodash';
import chalk from 'chalk';
import { Command } from 'commander';
import { v4 as uuidv4, v7, validate } from 'uuid';
import { formatDistanceToNow, addDays } from 'date-fns';
import { tr } from 'date-fns/locale';
import * as z from 'zod';
import type { User } from '@/types';
import { sum } from '../types';

const app = express();
app.use(express.json());
app.use(express.static('public'));
const router = Router();
router.get('/me', (req: Request, res: Response) => {
  res.json({ user: req.user, id: uuidv4(), at: formatDistanceToNow(addDays(new Date(), 1), { locale: tr }) });
});
app.use(router);

const program = new Command();
program.option('-p, --port <n>').parse();
console.log(chalk.green.bold('ok'), _.chunk([1, 2, 3], 2), get({ a: 1 }, 'a'), debounce(() => {}, 10), v7(), validate('x'), sum(1, 2));

const schema = z.object({ email: z.email(), name: z.string().min(1).max(50).trim() });
export type Input = z.infer<typeof schema>;
export const parsed = schema.safeParse({}).success;
export const u: User | null = null;
app.listen(Number(program.opts().port ?? 3000));
