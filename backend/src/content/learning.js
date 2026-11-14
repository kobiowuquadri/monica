// Concise educational cards. Every factual statement is tied to a registered NASA source
// (sourceKey + section/locator). Text marked `monicaPolicy` describes MONICA's own behaviour
// and is not presented as a NASA statement. No NASA endorsement is claimed.
import { SOURCES } from './sources.js';

const RAW_CARDS = [
  {
    id: 'dose-vs-dose-rate',
    title: 'Radiation dose versus dose rate',
    summary: 'A dose is energy absorbed per unit mass; a dose rate is how quickly that dose accumulates.',
    points: [
      { text: 'Absorbed dose is the energy deposited per unit mass, usually expressed in gray (Gy), where 1 Gy = 1 joule per kilogram.', sourceKey: 'msl-rad-rdr-sis', locator: 'Glossary: "Dose"' },
      { text: 'RAD RDR files report the total dose for detectors B and E in microgray per hour (µGy/h) — a dose rate for each observation.', sourceKey: 'msl-rad-rdr-sis', locator: '§4.2.1.6 Dosimetry' },
      { text: 'Dose equivalent weights dose by the biological effectiveness of the radiation field using a quality factor, and is reported in sieverts (Sv).', sourceKey: 'msl-rad-rdr-sis', locator: 'Glossary: "Dose Equivalent", "Quality Factor"' },
    ],
    monicaPolicy: 'MONICA shows RAD values exactly as archived (absorbed dose rate, µGy/h). It does not convert gray to sieverts and does not add detector channels together.',
  },
  {
    id: 'environment-vs-personal',
    title: 'Environmental versus personal measurements',
    summary: 'A detector on a rover measures its surroundings, not a crew member\'s body.',
    points: [
      { text: 'The RAD data set describes the energetic particle environment experienced by the Curiosity rover at the surface of Mars.', sourceKey: 'msl-rad-rdr', locator: 'RAD_RDR_DS.CAT — Data Set Overview' },
      { text: 'Astronaut exposure depends on mission location, the radiation environment at that location, and protective shielding such as spacecraft or spacesuit structure and materials.', sourceKey: 'nasa-srag-how', locator: 'Opening section' },
    ],
    monicaPolicy: 'MONICA labels RAD values as historical rover measurements and never presents them as a crew member\'s personal or career dose.',
  },
  {
    id: 'vitals-vs-diagnosis',
    title: 'Vital signs versus diagnosis',
    summary: 'A recorded reading is an observation. Clinical status is determined through clinical evaluation.',
    points: [
      { text: 'NASA\'s human performance standard describes crew behavioural health and cognitive status as determined by behavioural health evaluations against clinically accepted values.', sourceKey: 'nasa-std-3001-hp', locator: '§4.3.1 Mission Cognitive Status [V1 4011]' },
      { text: 'Those technical requirements are intended, among other things, to aid medical decision-making during space missions and are based on scientific and clinical evidence.', sourceKey: 'nasa-std-3001-hp', locator: '§4 Human Performance — introduction' },
    ],
    monicaPolicy: 'MONICA does not perform clinical evaluations. It records what you measured and reported, explains which rule produced each observation, and never labels a reading as normal or abnormal.',
  },
  {
    id: 'missing-data',
    title: 'Missing data and uncertainty',
    summary: 'An absent value is unknown — not healthy, and not zero.',
    points: [
      { text: 'The RAD archive volume notes that, although considerable care was taken, errors are possible, and advises users to exercise caution.', sourceKey: 'msl-rad-readme', locator: 'AAREADME.TXT §5 Errata and Disclaimer' },
      { text: 'RAD observations carry a QC field: 00000000 means no quality-control issues identified; bit 1 means unknown quality-control issues may exist; other bits record instrument modes. The SIS also notes QC was a placeholder when written.', sourceKey: 'msl-rad-rdr-sis', locator: '§4.2.1.2 The Observation Section' },
    ],
    monicaPolicy: 'MONICA shows "No reading recorded" or "Not assessed" when data are missing, breaks chart lines at gaps, and keeps flagged RAD samples out of the default chart.',
  },
  {
    id: 'why-follow-up',
    title: 'Why health follow-up matters',
    summary: 'Monitoring is continuous — a single check-in is a snapshot.',
    points: [
      { text: 'Crewmember behavioural, psychosocial and cognitive state is assessed and monitored through all mission phases.', sourceKey: 'nasa-std-3001-hp', locator: '§4.3 Fitness-for-Duty Behavioral Health and Cognition' },
      { text: 'End-of-mission care includes assessment, monitoring and, as needed, transitioning the crewmember back to pre-mission values.', sourceKey: 'nasa-std-3001-hp', locator: '§4.3.2 [V1 4012]' },
      { text: 'During energetic particle enhancements, NASA radiation specialists provide recommendations to the Flight Surgeon to mitigate crew exposure.', sourceKey: 'nasa-srag-how', locator: 'Providing Radiological Support During Missions' },
    ],
    monicaPolicy: 'MONICA lets you acknowledge an observation, record what you did, schedule a follow-up check-in and prepare a review summary. It does not contact anyone on your behalf.',
  },
  {
    id: 'radiation-sources-risks',
    title: 'Where space radiation comes from',
    summary: 'Beyond Earth\'s protective atmosphere, crews encounter solar particles and galactic cosmic rays.',
    points: [
      { text: 'Outside Earth\'s atmosphere, astronauts are exposed to ionising radiation from energetic particles from the Sun and from galactic cosmic rays.', sourceKey: 'nasa-hrp-sre', locator: 'Overview' },
      { text: 'NASA\'s Space Radiation Element studies risks including cancer, central nervous system effects, degenerative diseases such as cataracts and heart disease, and acute radiation sickness — and notes scientists do not fully understand all the ways this radiation affects the body.', sourceKey: 'nasa-hrp-sre', locator: 'Overview' },
    ],
    monicaPolicy: 'MONICA never infers radiation injury from heart rate, fatigue, nausea or vomiting, and never estimates dose from symptom timing.',
  },
  {
    id: 'alara-and-limits',
    title: 'ALARA and exposure limits',
    summary: 'NASA minimises exposure below defined limits — limits MONICA does not attempt to calculate.',
    points: [
      { text: 'All crewmember radiation exposures shall be minimised using the As Low As Reasonably Achievable (ALARA) principle.', sourceKey: 'nasa-std-3001-hp', locator: '§4.8.1 [V1 4029]' },
      { text: 'NASA\'s career limit is expressed as total career effective dose (600 mSv), calculated with NASA\'s specified risk model parameters — a different quantity from a detector\'s absorbed dose rate.', sourceKey: 'nasa-std-3001-hp', locator: '§4.8.2 [V1 4030]' },
    ],
    monicaPolicy: 'MONICA does not compute effective dose or compare RAD rover data with personal limits; that would need a validated model and personal dosimetry.',
  },
  {
    id: 'space-weather-context',
    title: 'Reading space-weather events carefully',
    summary: 'An event observed near Earth is context, not a measurement at Mars.',
    points: [
      { text: 'DONKI chronicles daily interpretations of space-weather observations, analysis, models, forecasts and notifications, with links between related activities.', sourceKey: 'api-nasa-donki-docs', locator: 'DONKI description' },
      { text: 'Exposure depends on the radiation environment at the mission location.', sourceKey: 'nasa-srag-how', locator: 'Opening section' },
    ],
    monicaPolicy: 'MONICA lists DONKI events with their observing instruments and links. It never converts a flare class into a dose and never issues a shelter alert from an Earth-observed event.',
  },
];

const SOURCE_TITLES = Object.fromEntries(SOURCES.map((s) => [s.key, s.title]));

/** Cards with each cited source's title resolved; an unknown sourceKey fails loudly at start-up. */
export const LEARNING_CARDS = RAW_CARDS.map((card) => ({
  ...card,
  points: card.points.map((p) => {
    if (!SOURCE_TITLES[p.sourceKey]) throw new Error(`Learning card ${card.id} cites unknown source ${p.sourceKey}`);
    return { ...p, sourceTitle: SOURCE_TITLES[p.sourceKey] };
  }),
}));
