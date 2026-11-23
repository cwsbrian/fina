"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CreateCategoryBody, PatchCategoryBody, type CategoryDTO } from "@fina/shared";
import { apiFetch, useActiveWorkspaceId } from "../../../lib/api";
import styles from "../finance.module.css";

type Category = Pick<CategoryDTO, "id" | "name" | "type" | "icon" | "color">;
const CATEGORY_ICONS = [
  "pricetag-outline",
  "cart-outline",
  "cafe-outline",
  "restaurant-outline",
  "car-outline",
  "home-outline",
  "flash-outline",
  "heart-outline",
  "bag-handle-outline",
  "film-outline",
  "trending-up",
  "airplane-outline",
  "gift-outline",
  "fitness-outline",
  "school-outline",
  "paw-outline",
  "briefcase-outline",
  "book-outline",
  "musical-notes-outline",
  "construct-outline",
];

export default function CategoriesPage() {
  const workspaceId = useActiveWorkspaceId();
  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState<"expense" | "income">("expense");
  const [icon, setIcon] = useState("pricetag-outline");
  const [color, setColor] = useState("#3eb38b");
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [editIcon, setEditIcon] = useState("pricetag-outline");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch<{ categories: Category[] }>(
        `/workspaces/${workspaceId}/categories`,
      );
      setCategories(result.categories);
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not load categories.");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId || busy) return;
    const parsed = CreateCategoryBody.safeParse({ name, type, icon, color });
    if (!parsed.success) {
      setError("Enter a category name of up to 40 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/categories`, {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      setName("");
      setIcon("pricetag-outline");
      await load();
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not create category.");
    } finally {
      setBusy(false);
    }
  }

  async function change(id: string, body: unknown) {
    if (!workspaceId || busy) return;
    const parsed = PatchCategoryBody.safeParse(body);
    if (!parsed.success) {
      setError("Check the category details.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/categories/${id}`, {
        method: "PATCH",
        body: JSON.stringify(parsed.data),
      });
      setEditId(null);
      await load();
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not update category.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>Categories</h1>
          <p className={styles.sub}>
            Create and edit categories used in transactions, budgets, and goals.
          </p>
        </div>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <form className={styles.panel} onSubmit={create}>
        <div className={styles.panelHead}>
          <h2 className={styles.panelTitle}>New category</h2>
        </div>
        <div className={styles.formGrid}>
          <div className={styles.field}>
            <label htmlFor="category-name">Name</label>
            <input
              className={styles.input}
              id="category-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={40}
              required
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="category-type">Type</label>
            <select
              className={styles.input}
              id="category-type"
              value={type}
              onChange={(event) => setType(event.target.value as "expense" | "income")}
            >
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="category-icon">Icon</label>
            <select
              className={styles.input}
              id="category-icon"
              value={icon}
              onChange={(event) => setIcon(event.target.value)}
            >
              {CATEGORY_ICONS.map((choice) => (
                <option key={choice} value={choice}>
                  {choice.replace("-outline", "").replaceAll("-", " ")}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="category-color">Color</label>
            <input
              className={styles.input}
              id="category-color"
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
            />
          </div>
          <div className={styles.formActions}>
            <button className={styles.button} type="submit" disabled={busy}>
              Add category
            </button>
          </div>
        </div>
      </form>
      {(["expense", "income"] as const).map((group) => (
        <section className={styles.section} key={group}>
          <h2 className={styles.sectionTitle}>{group === "expense" ? "Expense" : "Income"}</h2>
          <div className={`${styles.panel} ${styles.categoryRows}`}>
            {loading && <div className={styles.empty}>Loading categories…</div>}
            {!loading && categories.filter((category) => category.type === group).length === 0 && (
              <div className={styles.empty}>No {group} categories yet.</div>
            )}
            {categories
              .filter((category) => category.type === group)
              .map((category) => (
                <div className={styles.categoryManageRow} key={category.id}>
                  {editId === category.id ? (
                    <form
                      className={styles.categoryEdit}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void change(category.id, {
                          name: editName,
                          icon: editIcon,
                          color: editColor || null,
                        });
                      }}
                    >
                      <input
                        className={styles.input}
                        aria-label="Category name"
                        value={editName}
                        onChange={(event) => setEditName(event.target.value)}
                        maxLength={40}
                        required
                      />
                      <select
                        className={styles.input}
                        aria-label="Category icon"
                        value={editIcon}
                        onChange={(event) => setEditIcon(event.target.value)}
                      >
                        {CATEGORY_ICONS.map((choice) => (
                          <option key={choice} value={choice}>
                            {choice.replace("-outline", "").replaceAll("-", " ")}
                          </option>
                        ))}
                      </select>
                      <input
                        className={styles.input}
                        aria-label="Category color"
                        type="color"
                        value={editColor || "#3eb38b"}
                        onChange={(event) => setEditColor(event.target.value)}
                      />
                      <button className={styles.button} type="submit" disabled={busy}>
                        Save
                      </button>
                      <button
                        className={styles.buttonSecondary}
                        type="button"
                        onClick={() => setEditId(null)}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <>
                      <span className={styles.categoryManageName}>
                        <span
                          className={styles.categoryDot}
                          style={{ background: category.color ?? "var(--color-primary)" }}
                        />
                        {category.name}
                      </span>
                      <div className={styles.actions}>
                        <button
                          className={`${styles.buttonSecondary} ${styles.buttonSmall}`}
                          type="button"
                          onClick={() => {
                            setEditId(category.id);
                            setEditName(category.name);
                            setEditIcon(category.icon ?? "pricetag-outline");
                            setEditColor(category.color ?? "#3eb38b");
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className={`${styles.buttonSecondary} ${styles.buttonSmall}`}
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(`Archive ${category.name}?`))
                              void change(category.id, { archived: true });
                          }}
                        >
                          Archive
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
