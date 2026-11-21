import { APP_IDS, listRecords, makeId, putRecord, recordsPrefix } from "@tinyapps/appkit";

const EVENTS_PREFIX = recordsPrefix(APP_IDS.pain, "pain");

export const loadPainEvents = (tcw) => listRecords(tcw, EVENTS_PREFIX);

/** Writes one pain entry; `fields` are what the person entered. */
export const savePainEvent = (tcw, fields) => putRecord(tcw, EVENTS_PREFIX, { id: makeId("pain"), ts: Date.now(), ...fields });
