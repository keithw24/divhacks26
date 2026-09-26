import type { PhoneBookingRequest, PhoneBookingResult, RestaurantPhoneBookingService } from "./types.js";
import { FAILED_REPLY } from "./messages.js";

/**
 * Placeholder until the outbound-call agent supplies a RestaurantPhoneBookingService.
 * The reservation router does not need to change when that service is plugged in.
 */
export class UnpluggedPhoneBookingService implements RestaurantPhoneBookingService {
  async bookByPhone(_request: PhoneBookingRequest): Promise<PhoneBookingResult> {
    return {
      status: "FAILED",
      reason: "phone_subsystem_unavailable",
      reply: FAILED_REPLY,
    };
  }
}

export function restaurantIdOf(restaurant: { placeId?: string; name: string }): string {
  return restaurant.placeId?.trim() || restaurant.name;
}
