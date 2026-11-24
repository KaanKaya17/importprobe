export * from '../types';
export { default as Page } from './page';
export { chunk as split } from 'lodash';
export type { Request } from 'express';
export * as dates from 'date-fns';

const m = await import('date-fns');
export const year = m.format(new Date(), 'yyyy');
const name = 'tr';
export const loadLocale = () => import(`./locale/${name}.js`);
