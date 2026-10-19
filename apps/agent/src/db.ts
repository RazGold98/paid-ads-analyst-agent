import { MongoClient } from "mongodb";
import { config } from "./config.js";

// One client for the whole process; index.ts connects it at startup so a bad URI fails fast.
export const mongo = new MongoClient(config.mongo.uri);
export const db = mongo.db(config.mongo.db);
