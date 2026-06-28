import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const mobileRoot = join(__dirname, "../..");

function readBudgetScreen() {
  return readFileSync(join(mobileRoot, "app/budget/new.tsx"), "utf8");
}

describe("budget category sheet layout", () => {
  it("keeps only the title controls in the fixed category sheet header", () => {
    const source = readBudgetScreen();
    const fixedHeaderStart = source.indexOf("<View style={styles.sheetFixedHeader}>");
    const listStart = source.indexOf("<BottomSheetFlatList");
    const fixedHeaderSource = source.slice(fixedHeaderStart, listStart);

    expect(source).toContain("styles.sheetFixedHeader");
    expect(source).toContain("ListHeaderComponent={renderSheetListHeader}");
    expect(source).toContain("styles.sheetListHeader");
    expect(fixedHeaderSource).not.toContain("styles.suggestBtn");
    expect(fixedHeaderSource).not.toContain("onSuggest");
  });

  it("scrolls the focused category row into view without changing sheet height", () => {
    const source = readBudgetScreen();

    expect(source).toContain('const categorySnapPoints = useMemo(() => ["88%"], []);');
    expect(source).toContain("const categoryListRef = useRef<BottomSheetFlatListMethods>(null);");
    expect(source).toContain("const scrollCategoryInputIntoView = useCallback((index: number) => {");
    expect(source).toContain("categoryListRef.current?.scrollToIndex({");
    expect(source).toContain("ref={categoryListRef}");
    expect(source).toContain("onFocus={() => scrollCategoryInputIntoView(index)}");
    expect(source).toContain('keyboardBehavior="extend"');
    expect(source).toContain("BottomSheetTextInput");
    expect(source).not.toContain("snapToIndex(1)");
    expect(source).not.toContain("automaticallyAdjustKeyboardInsets");
    expect(source).not.toContain("keyboardBlurBehavior=");
    expect(source).not.toContain("android_keyboardInputMode=");
  });
});
