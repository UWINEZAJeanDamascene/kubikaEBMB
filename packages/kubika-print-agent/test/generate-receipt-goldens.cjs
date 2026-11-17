const fs = require('node:fs');
const path = require('node:path');
const { columnsList, expectedBytes, thermalJobTypes } = require('./fixtures/thermalDocuments.cjs');

const outputDirectory = path.join(__dirname, 'fixtures', 'receipt-goldens');
fs.mkdirSync(outputDirectory, { recursive: true });
for (const columns of columnsList) {
  for (const jobType of thermalJobTypes) {
    fs.writeFileSync(path.join(outputDirectory, `${jobType}-${columns}.bin`), expectedBytes(jobType, columns));
  }
}
console.log(`Wrote ${thermalJobTypes.length * columnsList.length} receipt renderer byte goldens.`);
