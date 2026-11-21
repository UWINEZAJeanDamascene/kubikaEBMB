'use strict';

const {
  FEATURE_CODES,
  FEATURE_REGISTRY,
  FEATURE_STATUS,
  PACK_MANIFESTS,
  PACK_STATUS,
  RESTAURANT_PACK,
  isRestaurantPackAssignable,
} = require('../services/posRestaurantFeatureRegistry');

const featuresByCode = new Map(FEATURE_REGISTRY.map((feature) => [feature.code, feature]));

describe('Restaurant and Bar Till feature registry', () => {
  test('registers unique Restaurant-only feature codes and valid dependencies', () => {
    expect(new Set(FEATURE_CODES).size).toBe(FEATURE_CODES.length);
    for (const feature of FEATURE_REGISTRY) {
      expect(feature.code).toMatch(/^restaurant\./);
      for (const dependency of feature.dependencies) {
        expect(featuresByCode.has(dependency)).toBe(true);
      }
    }
  });

  test('defines independent Kitchen and Bar displays and audible ticket alerts', () => {
    expect(featuresByCode.get('restaurant.kitchen_display')).toBeDefined();
    expect(featuresByCode.get('restaurant.bar_display')).toBeDefined();
    expect(featuresByCode.get('restaurant.ticket_alerts').dependencies).toEqual([
      'restaurant.kitchen_display',
      'restaurant.bar_display',
    ]);
  });

  test('keeps the Restaurant & Bar Till unavailable until required features are implemented', () => {
    expect(PACK_MANIFESTS['pack.restaurant']).toBe(RESTAURANT_PACK);
    expect(RESTAURANT_PACK).toMatchObject({
      code: 'pack.restaurant',
      name: 'Restaurant & Bar Till',
      status: PACK_STATUS.COMING_SOON,
    });
    expect(RESTAURANT_PACK.requiredFeatures).toEqual(FEATURE_CODES);
    expect(FEATURE_REGISTRY.every((feature) => feature.status === FEATURE_STATUS.PLANNED)).toBe(true);
    expect(isRestaurantPackAssignable()).toBe(false);
  });

  test('keeps planned Restaurant features unmapped from routes, screens, permissions, and jobs', () => {
    for (const feature of FEATURE_REGISTRY) {
      expect(feature.routes).toEqual([]);
      expect(feature.uiComponents).toEqual([]);
      expect(feature.permissions).toEqual([]);
      expect(feature.jobs).toEqual([]);
      expect(feature.tenantToggleable).toBe(false);
    }
  });
});
