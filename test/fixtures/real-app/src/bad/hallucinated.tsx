// Mistakes AI assistants really make with these libraries.
import { useQueryParams, useHistory } from 'react-router-dom'; // useQueryParams never existed; useHistory was removed in v6
import { render } from 'react-dom'; // removed in React 19 (use createRoot from react-dom/client)
import { formatRelativeTime } from 'date-fns'; // date-fns has formatRelative / formatDistance
import { addDays } from 'dayjs'; // dayjs is not even a dependency here, and addDays is date-fns
import _ from 'lodash';
import express from 'express';
import chalk from 'chalk';
import * as z from 'zod';
import { Command } from 'commander';

_.flatMapDeepest([]); // not a lodash function
express.bodyParser(); // removed back in Express 4
chalk.rainbow('x'); // not a chalk style

export const email = z.string().emailAddress(); // chained: zod has .email(), not .emailAddress()
const app = express();
app.listenAsync(3000); // chained: express apps have listen(), not listenAsync()
new Command().parseArgsAsync(); // chained: commander has parseAsync()

export { useQueryParams, useHistory, render, formatRelativeTime, addDays };
