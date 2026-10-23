import type { ColumnDto, DatasetDto } from "./types";

export const exploreColumns = (dataset: DatasetDto): ColumnDto[] =>
    dataset.columns.flatMap((column) => [
        column,
        ...(column.fields ?? []).map((field) => ({
            name: `${column.name}.${field.name}`,
            kind: "scalar" as const,
            numeric: field.numeric,
        })),
    ]);
const sameType = (left: ColumnDto, right: ColumnDto): boolean =>
    left.kind === right.kind && !!left.numeric === !!right.numeric;
export const sharedExploreColumns = (datasets: DatasetDto[]): ColumnDto[] =>
    datasets.length
        ? exploreColumns(datasets[0]).filter((column) =>
              datasets.every((dataset) =>
                  exploreColumns(dataset).some(
                      (candidate) =>
                          candidate.name.toLowerCase() ===
                              column.name.toLowerCase() &&
                          sameType(column, candidate),
                  ),
              ),
          )
        : [];

export const datasetCompatibility = (
    dataset: DatasetDto,
    current: ColumnDto[],
    used: string[],
): string => {
    if (dataset.error || !dataset.columns.length)
        return dataset.error || "Dataset has no available fields.";
    const columns = exploreColumns(dataset);
    for (const name of used) {
        const candidate = columns.find(
            (column) => column.name.toLowerCase() === name.toLowerCase(),
        );
        if (!candidate) return `Missing field: ${name}`;
        const existing = current.find(
            (column) => column.name.toLowerCase() === name.toLowerCase(),
        );
        if (existing && !sameType(existing, candidate))
            return `Different field type: ${name}`;
    }
    return "";
};
