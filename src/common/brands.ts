import { Job } from "bullmq";
import { countryCodes, dbServers, EngineType } from "../config/enums";
import { ContextType } from "../libs/logger";
import {
  jsonOrStringForDb,
  jsonOrStringToJson,
  stringOrNullForDb,
  stringToHash,
} from "../utils";
import _ from "lodash";
import { sources } from "../sites/sources";
import items from "./../../pharmacyItems.json";
import connections from "./../../brandConnections.json";
import {
  BRAND_AS_FIRST_OR_SECOND_WORD,
  BRAND_AS_FIRST_WORD,
  BRAND_CASE_SENSITIVE,
  BRAND_IGNORE_LIST,
} from "./constants";

type BrandsMapping = {
  [key: string]: string[];
};

export async function getBrandsMapping(): Promise<BrandsMapping> {
  //     const query = `
  //     SELECT
  //     LOWER(p1.manufacturer) manufacturer_p1
  //     , LOWER(GROUP_CONCAT(DISTINCT p2.manufacturer ORDER BY p2.manufacturer SEPARATOR ';')) AS manufacturers_p2
  // FROM
  //     property_matchingvalidation v
  // INNER JOIN
  //     property_pharmacy p1 ON v.m_source = p1.source
  //     AND v.m_source_id = p1.source_id
  //     AND v.m_country_code = p1.country_code
  //     AND p1.newest = true
  // INNER JOIN
  //     property_pharmacy p2 ON v.c_source = p2.source
  //     AND v.c_source_id = p2.source_id
  //     AND v.c_country_code = p2.country_code
  //     AND p2.newest = true
  // WHERE
  //     v.m_source = 'AZT'
  //     AND v.engine_type = '${EngineType.Barcode}'
  //     and p1.manufacturer is not null
  //     and p2.manufacturer is not null
  //     and p1.manufacturer not in ('kita', 'nera', 'cits')
  //     and p2.manufacturer not in ('kita', 'nera', 'cits')
  // GROUP BY
  //     p1.manufacturer
  //     `
  //     const brandConnections = await executeQueryAndGetResponse(dbServers.pharmacy, query)
  // For this test day purposes exported the necessary object
  const brandConnections = connections;

  const getRelatedBrands = (
    map: Map<string, Set<string>>,
    brand: string
  ): Set<string> => {
    const relatedBrands = new Set<string>();
    const queue = [brand];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (map.has(current)) {
        const brands = map.get(current)!;
        for (const b of brands) {
          if (!relatedBrands.has(b)) {
            relatedBrands.add(b);
            queue.push(b);
          }
        }
      }
    }
    return relatedBrands;
  };

  // Create a map to track brand relationships
  const brandMap = new Map<string, Set<string>>();

  brandConnections.forEach(({ manufacturer_p1, manufacturers_p2 }) => {
    const brand1 = manufacturer_p1.toLowerCase();
    const brands2 = manufacturers_p2.toLowerCase();
    const brand2Array = brands2.split(";").map((b) => b.trim());
    if (!brandMap.has(brand1)) {
      brandMap.set(brand1, new Set());
    }
    brand2Array.forEach((brand2) => {
      if (!brandMap.has(brand2)) {
        brandMap.set(brand2, new Set());
      }
      brandMap.get(brand1)!.add(brand2);
      brandMap.get(brand2)!.add(brand1);
    });
  });

  // Build the final flat map
  const flatMap = new Map<string, Set<string>>();

  brandMap.forEach((_, brand) => {
    const relatedBrands = getRelatedBrands(brandMap, brand);
    flatMap.set(brand, relatedBrands);
  });

  // Convert the flat map to an object for easier usage
  const flatMapObject: Record<string, string[]> = {};

  flatMap.forEach((relatedBrands, brand) => {
    flatMapObject[brand] = Array.from(relatedBrands);
  });

  return flatMapObject;
}

async function getPharmacyItems(
  countryCode: countryCodes,
  source: sources,
  versionKey: string,
  mustExist = true
) {
  //     let query = `
  //     SELECT
  //     p.url, p.removed_timestamp, p.title, p.source_id
  //     , p.manufacturer
  //     , map.source_id m_id
  //     , map.source
  //     , map.country_code
  //     , map.meta
  // FROM
  //     property_pharmacy p
  // left join pharmacy_mapping map on p.source_id = map.source_id and p.source = map.source and p.country_code = map.country_code
  // WHERE
  //     p.newest = TRUE
  //     and p.country_code = '${countryCode}'
  //     and p.source = '${source}'
  //     and p.removed_timestamp is null
  //     and (p.manufacturer is null or p.manufacturer in ('nera', 'kita', 'cits'))
  //     ORDER BY p.removed_timestamp IS NULL DESC, p.removed_timestamp DESC
  //     `
  //     let products = await executeQueryAndGetResponse(dbServers.pharmacy, query)
  //     for (let product of products) {
  //         product.meta = jsonOrStringToJson(product.meta)
  //     }

  //     let finalProducts = products.filter((product) => (!mustExist || product.m_id) && !product.meta[versionKey])
  const finalProducts = items;

  return finalProducts;
}

export function checkBrandIsSeparateTerm(
  input: string,
  brand: string,
  prioritizeBeginningMatch = false
): boolean {
  // Normalize the input to remove diacritics and special characters
  input = removePhoneticCharacters(input);
  brand = removePhoneticCharacters(brand);

  // Escape any special characters in the brand name for use in a regular expression
  let escapedBrand = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").toLowerCase();
  const escapedBrandLower = escapedBrand.toLowerCase();

  const foundInCaseSensitive = BRAND_CASE_SENSITIVE.find(
    (b) => b.toLowerCase() === escapedBrandLower
  );
  const flags = foundInCaseSensitive ? "i" : "";
  escapedBrand = foundInCaseSensitive ?? escapedBrand;

  if (prioritizeBeginningMatch) {
    // If we prioritize matches at the beginning of the title, we check if the brand is at the beginning
    const atBeginning = new RegExp(`^${escapedBrand}\\s*`, flags).test(input);
    if (atBeginning) return atBeginning;
  }

  if (
    BRAND_AS_FIRST_WORD.includes(escapedBrandLower) ||
    BRAND_AS_FIRST_OR_SECOND_WORD.includes(escapedBrandLower)
  ) {
    // If the brand is a first word, we check if it is at the beginning of the string
    const atBeginning = new RegExp(`^${escapedBrand}\\s*`, flags).test(input);
    return atBeginning;
  }

  if (BRAND_AS_FIRST_OR_SECOND_WORD.includes(escapedBrandLower)) {
    // only test for second word if the brand is in the list of first or second words
    const atBeginningOrSecond = new RegExp(
      `^[^\\s]+\\s+${escapedBrand}\\s*`,
      flags
    ).test(input);

    return atBeginningOrSecond;
  }

  // Check if the brand is at the beginning or end of the string
  const atBeginningOrEnd = new RegExp(
    `^(?:${escapedBrand}\\s|.*\\s${escapedBrand}\\s.*|.*\\s${escapedBrand})$`,
    flags
  ).test(input);

  // Check if the brand is a separate term in the string
  const separateTerm = new RegExp(`\\b${escapedBrand}\\b`, "i").test(input);

  // The brand should be at the beginning, end, or a separate term
  return atBeginningOrEnd || separateTerm;
}

function removePhoneticCharacters(input: string): string {
  return input.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * DFS from the given brand to find all related brands.
 */
function visitKey(
  brandsMapping: BrandsMapping,
  brand: string,
  visited: Set<string>
) {
  if (visited.has(brand)) {
    return new Set();
  }
  visited.add(brand);
  const relatedBrands = new Set<string>();
  relatedBrands.add(brand);

  for (const neighbour of brandsMapping[brand] || []) {
    if (!visited.has(neighbour)) {
      relatedBrands.add(neighbour);
      const myRelatedBrands = visitKey(brandsMapping, neighbour, visited);
      myRelatedBrands.forEach((b: string) => relatedBrands.add(b));
    }
  }

  return relatedBrands;
}

/**
 * groups related brands into a single array for each brand
 * in the brandsMapping object. 
 * 
 */
function flatenBrandsMapping(brandsMapping: BrandsMapping): BrandsMapping {
  const brandMap: BrandsMapping = {};
  const visited = new Set<string>();

  //for each unvisited brand, find all related brands for it
  for (const brand in brandsMapping) {
    if (!visited.has(brand)) {
      const relatedBrands = visitKey(brandsMapping, brand, visited);
      brandMap[brand] = Array.from(relatedBrands as Set<string>);
    }
  }

  return brandMap;
}
export async function assignBrandIfKnown(
  countryCode: countryCodes,
  source: sources,
  job?: Job
) {
  const context = { scope: "assignBrandIfKnown" } as ContextType;

  const brandsMapping = await getBrandsMapping();
  const flatBrandsMapping = flatenBrandsMapping(brandsMapping);

  const versionKey = "assignBrandIfKnown";
  let products = await getPharmacyItems(countryCode, source, versionKey, false);
  let counter = 0;

  for (let product of products) {
    counter++;

    if (product.m_id) {
      // Already exists in the mapping table, probably no need to update
      continue;
    }

    let matchedBrands = new Set<string>();
    for (const brandKey in flatBrandsMapping) {
      const relatedBrands = flatBrandsMapping[brandKey];
      for (const brand of relatedBrands) {
        if (BRAND_IGNORE_LIST.includes(brand.toLowerCase())) {
          continue;
        }
        if (matchedBrands.has(brand)) {
          continue;
        }
        const isBrandMatch = checkBrandIsSeparateTerm(
          product.title,
          brand,
          matchedBrands.size > 1 //we prioritize matches at the beginning of the title
        );
        if (isBrandMatch) {
          matchedBrands.add(brandKey);
        }
      }
    }
    console.log(`${product.title} -> ${Array.from(matchedBrands).join(", ")}`);
    const sourceId = product.source_id;
    const meta = { matchedBrands };
    const brand = matchedBrands.size ? matchedBrands[0] : null;

    const key = `${source}_${countryCode}_${sourceId}`;
    const uuid = stringToHash(key);

    // Then brand is inserted into product mapping table
  }
}
