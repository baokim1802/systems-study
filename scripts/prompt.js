// Prints the AI grading prompt for a day (the same text as the 📋 button in the app).
//   npm run prompt -- 14          -> day 14 (number, id or part of the name)
//   npm run prompt -- http > p.md
const catalog = require('../lib/catalog');
const store = require('../lib/store');

(async () => {
  const shared = await store.init();
  const query = process.argv[2];
  const meta = query ? catalog.findDay(query) : catalog.listDays().find((d) => !store.loadProgress().days[d.id]?.done);
  if (!meta) {
    console.error(query ? `No day matches "${query}".` : 'Every day is finished 🎉');
    process.exit(1);
  }
  process.stdout.write(shared.buildPrompt(catalog.readDay(meta.id), store.loadAnswers(meta.id)));
})();
