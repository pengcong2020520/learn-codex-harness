// Test-only: traces raw-driver failures too, even when a service catches the rejection.
import pg from 'pg';
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  const origin = new Error('CT001 query origin');
  const report = error => {
    if (error?.code === 'CT001') console.error('[CT001]', typeof args[0] === 'string' ? args[0] : args[0]?.text, origin.stack);
  };
  const last = args.at(-1);
  if (typeof last === 'function') args[args.length - 1] = (error, ...rest) => { report(error); return last(error, ...rest); };
  const result = query.apply(this, args);
  return result?.catch ? result.catch(error => { report(error); throw error; }) : result;
};
