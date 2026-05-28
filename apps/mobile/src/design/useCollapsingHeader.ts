import { useCallback, useRef } from "react";
import { Animated, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";

type Result = {
  /** Apply to the Animated.View wrapping the screen header. */
  headerStyle: { transform: { translateY: Animated.Value }[] };
  /** Attach to the scrollable child's onScroll prop. */
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** scrollEventThrottle to pair with onScroll. 1 keeps the header
   *  glued to the finger; React Native delivers every available frame. */
  scrollEventThrottle: number;
  /** Imperatively snap the header back to fully visible. Call when the
   *  scrollable underneath is swapped (e.g. a new chat thread mounts
   *  with empty content but the header state from the previous view
   *  is still translated up). */
  reset: () => void;
};

/** Sticky-style collapsing header. The header's translateY tracks scroll
 *  delta 1:1 — scroll the list up by N px and the header rises by N px
 *  (clamped to `-headerHeight`); reverse direction and it slides back
 *  down by the same amount. No timing animation, so it stays glued to
 *  the finger. At y <= 0 the header is always fully visible.
 *
 *  Layout contract: place the header in an absolutely-positioned overlay
 *  at the top of the screen, and reserve `headerHeight` worth of
 *  `paddingTop` on the scrollable child so the first item isn't covered. */
export function useCollapsingHeader(headerHeight: number): Result {
  const translateY = useRef(new Animated.Value(0)).current;
  const lastY = useRef(0);
  const current = useRef(0);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    const dy = y - lastY.current;
    lastY.current = y;

    // At/above the top edge: always fully reveal. Avoids a stuck-hidden
    // state if the user reaches the top and the bounce overshoots.
    if (y <= 0) {
      if (current.current !== 0) {
        current.current = 0;
        translateY.setValue(0);
      }
      return;
    }

    let next = current.current - dy;
    if (next < -headerHeight) next = -headerHeight;
    if (next > 0) next = 0;
    if (next === current.current) return;
    current.current = next;
    translateY.setValue(next);
  };

  const reset = useCallback(() => {
    current.current = 0;
    lastY.current = 0;
    translateY.setValue(0);
  }, [translateY]);

  return {
    headerStyle: { transform: [{ translateY }] },
    onScroll,
    scrollEventThrottle: 1,
    reset,
  };
}
