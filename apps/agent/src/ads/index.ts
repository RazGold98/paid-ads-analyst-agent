import { config } from "../config.js";
import { AdsApiClient } from "./client.js";
import { accountOverview, comparePeriods, getPerformance, listAdSets } from "./tools.js";

/** The ads tools wired to the configured API, ready for the agent to call. */
export function createAdsTools() {
  const client = new AdsApiClient(config.adsApi);
  return {
    listAdSets: () => listAdSets(client),
    getPerformance: (args?: Parameters<typeof getPerformance>[1]) => getPerformance(client, args),
    comparePeriods: (args?: Parameters<typeof comparePeriods>[1]) => comparePeriods(client, args),
    accountOverview: (args?: Parameters<typeof accountOverview>[1]) => accountOverview(client, args),
  };
}

export type AdsTools = ReturnType<typeof createAdsTools>;
export { AdsApiError } from "./client.js";
export type * from "./types.js";
