import { config } from "../config.js";
import { AdsApiClient } from "./client.js";
import { accountOverview, comparePeriods, getPerformance, listAdSets } from "./tools.js";

export function createAdsClient(): AdsApiClient {
  return new AdsApiClient(config.adsApi);
}

/** The ads tools wired to an API client, ready for the agent to call. */
export function createAdsTools(client: AdsApiClient = createAdsClient()) {
  return {
    listAdSets: () => listAdSets(client),
    getPerformance: (args?: Parameters<typeof getPerformance>[1]) => getPerformance(client, args),
    comparePeriods: (args?: Parameters<typeof comparePeriods>[1]) => comparePeriods(client, args),
    accountOverview: (args?: Parameters<typeof accountOverview>[1]) => accountOverview(client, args),
  };
}

export type AdsTools = ReturnType<typeof createAdsTools>;
export { AdsApiClient, AdsApiError } from "./client.js";
export type * from "./types.js";
