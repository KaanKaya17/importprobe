import dayjs from 'dayjs';
import { formatRelative } from 'dayjs'; // that's date-fns, not dayjs
import relativeTime from 'dayjs/plugin/relativeTimes'; // real path is dayjs/plugin/relativeTime

dayjs.extend(relativeTime);

export const ago = (d: Date) => formatRelative(d, new Date());
export const pretty = (d: Date) => dayjs(d).format('DD.MM.YYYY');
