// apps/api/tests/iap/status-mapping.test.ts
import { describe, it, expect } from "vitest";
import { mapAppleStatus, mapGoogleStatus } from "../../src/iap/status-mapping.js";

describe("mapAppleStatus", () => {
  it("SUBSCRIBED → active", () => {
    expect(mapAppleStatus({ subscriptionStatus: "SUBSCRIBED" })).toEqual({
      status: "active",
      cancelAtPeriodEnd: false,
    });
  });
  it("SUBSCRIBED + offerType=1 → trialing", () => {
    expect(mapAppleStatus({ subscriptionStatus: "SUBSCRIBED", offerType: 1 })).toEqual({
      status: "trialing",
      cancelAtPeriodEnd: false,
    });
  });
  it("SUBSCRIBED + unknown offerType fails closed to trialing", () => {
    expect(mapAppleStatus({ subscriptionStatus: "SUBSCRIBED", offerType: 99 })).toEqual({
      status: "trialing",
      cancelAtPeriodEnd: false,
    });
  });
  it("BILLING_RETRY → past_due", () => {
    expect(mapAppleStatus({ subscriptionStatus: "BILLING_RETRY" })).toEqual({
      status: "past_due",
      cancelAtPeriodEnd: false,
    });
  });
  it("EXPIRED → canceled", () => {
    expect(mapAppleStatus({ subscriptionStatus: "EXPIRED" })).toEqual({
      status: "canceled",
      cancelAtPeriodEnd: false,
    });
  });
  it("REVOKED → canceled", () => {
    expect(mapAppleStatus({ subscriptionStatus: "REVOKED" })).toEqual({
      status: "canceled",
      cancelAtPeriodEnd: false,
    });
  });
  it("PAUSED → paused", () => {
    expect(mapAppleStatus({ subscriptionStatus: "PAUSED" })).toEqual({
      status: "paused",
      cancelAtPeriodEnd: false,
    });
  });
  it("SUBSCRIBED + autoRenewStatus=0 → active+cancelAtPeriodEnd", () => {
    expect(mapAppleStatus({ subscriptionStatus: "SUBSCRIBED", autoRenewStatus: 0 })).toEqual({
      status: "active",
      cancelAtPeriodEnd: true,
    });
  });
});

describe("mapGoogleStatus", () => {
  const future = new Date(Date.now() + 86400_000);
  const past = new Date(Date.now() - 1);

  it("ACTIVE → active", () => {
    expect(mapGoogleStatus({ subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", expiryTime: future })).toEqual({
      status: "active", cancelAtPeriodEnd: false,
    });
  });
  it("IN_GRACE_PERIOD → past_due", () => {
    expect(mapGoogleStatus({ subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD", expiryTime: future })).toEqual({
      status: "past_due", cancelAtPeriodEnd: false,
    });
  });
  it("ON_HOLD → past_due (product decision)", () => {
    expect(mapGoogleStatus({ subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD", expiryTime: future })).toEqual({
      status: "past_due", cancelAtPeriodEnd: false,
    });
  });
  it("PAUSED → paused", () => {
    expect(mapGoogleStatus({ subscriptionState: "SUBSCRIPTION_STATE_PAUSED", expiryTime: future })).toEqual({
      status: "paused", cancelAtPeriodEnd: false,
    });
  });
  it("EXPIRED → canceled", () => {
    expect(mapGoogleStatus({ subscriptionState: "SUBSCRIPTION_STATE_EXPIRED", expiryTime: past })).toEqual({
      status: "canceled", cancelAtPeriodEnd: false,
    });
  });
  it("CANCELED + future expiryTime → active + cancelAtPeriodEnd", () => {
    expect(mapGoogleStatus({ subscriptionState: "SUBSCRIPTION_STATE_CANCELED", expiryTime: future })).toEqual({
      status: "active", cancelAtPeriodEnd: true,
    });
  });
  it("CANCELED + past expiryTime → canceled", () => {
    expect(mapGoogleStatus({ subscriptionState: "SUBSCRIPTION_STATE_CANCELED", expiryTime: past })).toEqual({
      status: "canceled", cancelAtPeriodEnd: false,
    });
  });
  it("PENDING → incomplete", () => {
    expect(mapGoogleStatus({ subscriptionState: "SUBSCRIPTION_STATE_PENDING", expiryTime: future })).toEqual({
      status: "incomplete", cancelAtPeriodEnd: false,
    });
  });
});
