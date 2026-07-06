using System.Text.RegularExpressions;
using SwarmUI.Utils;

namespace Quarry;

public sealed record QueryRunMatch(string Name, long Matches);
public sealed record QueryRunRow(string Dataset, string Prompt);

public sealed record QueryRunResult(string Invalid, long Total, IReadOnlyList<QueryRunMatch> Datasets, IReadOnlyList<QueryRunRow> Rows, IReadOnlyList<string> Highlights)
{
    public bool Truncated => Total > Rows.Count;

    public static QueryRunResult ForInvalid(string reason) => new(reason, 0, [], [], []);
}

public static class QueryRunner
{
    public const int DefaultMaxResults = 25;

    private static readonly Regex FullTagRegex =
        new(@"^<q(?:\[\d+(?:-\d+)?\])?:([^>]*)>$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public static string NormalizeQueryInput(string input)
    {
        string trimmed = (input ?? "").Trim();
        Match match = FullTagRegex.Match(trimmed);
        return match.Success ? match.Groups[1].Value.Trim() : trimmed;
    }

    public static int ClampMaxResults(int maxResults)
        => maxResults <= 0 ? DefaultMaxResults : maxResults;

    public static QueryRunResult Run(string queryText, int maxResults)
    {
        int limit = ClampMaxResults(maxResults);
        string text = NormalizeQueryInput(queryText);
        if (text.Length == 0)
        {
            return QueryRunResult.ForInvalid("Query is empty.");
        }
        Query query;
        try
        {
            query = QueryParser.Parse(text);
        }
        catch (QueryException ex)
        {
            return QueryRunResult.ForInvalid($"Invalid query '{text}': {ex.Message}");
        }
        if (string.IsNullOrEmpty(query.Name))
        {
            return QueryRunResult.ForInvalid("The query has a filter but no dataset selected.");
        }
        List<DatasetEntry> targets = PromptTagHandler.ResolveTargets(query.Name);
        if (targets.Count == 0)
        {
            return QueryRunResult.ForInvalid($"No dataset matches '{query.Name}'.");
        }
        bool multi = query.Name.Contains(',') || DatasetNameMatching.IsGlob(query.Name);
        List<Plan> plans = [];
        foreach (DatasetEntry entry in targets)
        {
            Plan plan;
            try
            {
                plan = DraftPlan(query, entry);
            }
            catch (QueryException ex) when (!multi)
            {
                return QueryRunResult.ForInvalid(ex.Message);
            }
            catch (Exception ex) when (multi)
            {
                Logs.Debug($"Quarry: skipping '{entry.Name}' in '{query.Name}': {ex.Message}");
                continue;
            }
            if (plan is null)
            {
                if (!multi)
                {
                    return QueryRunResult.ForInvalid($"Dataset '{entry.Name}' has no columns to read.");
                }
                continue;
            }
            plans.Add(plan);
        }
        DatasetManager.WarmFilteredCounts([.. plans.Where(plan => !plan.Filter.IsEmpty).Select(plan => (plan.Entry, plan.Filter))]);
        long total = 0;
        List<(Plan Plan, long Count)> matched = [];
        foreach (Plan plan in plans)
        {
            long count;
            try
            {
                count = plan.Filter.IsEmpty
                    ? DatasetManager.GetRowCount(plan.Entry, plan.PromptColumn)
                    : DatasetManager.CountRowsFiltered(plan.Entry, plan.Filter);
            }
            catch (Exception ex) when (multi)
            {
                Logs.Debug($"Quarry: skipping '{plan.Entry.Name}' in '{query.Name}': {ex.Message}");
                continue;
            }
            if (count <= 0)
            {
                continue;
            }
            total += count;
            matched.Add((plan, count));
        }
        List<QueryRunRow> rows = [];
        foreach ((Plan plan, long _) in matched)
        {
            if (rows.Count >= limit)
            {
                break;
            }
            List<List<string>> fetched;
            try
            {
                (_, fetched) = DatasetManager.Backend.GetFilteredRows(
                    plan.Entry.Path, [plan.PromptColumn], plan.Filter, sortColumn: null, sortDescending: false, limit - rows.Count, 0);
            }
            catch (Exception ex) when (multi)
            {
                Logs.Debug($"Quarry: skipping rows from '{plan.Entry.Name}' in '{query.Name}': {ex.Message}");
                continue;
            }
            foreach (List<string> row in fetched)
            {
                string prompt = row.Count > 0 ? row[0] : "";
                if (!string.IsNullOrWhiteSpace(prompt))
                {
                    rows.Add(new QueryRunRow(plan.Entry.Name, prompt));
                }
            }
        }
        List<QueryRunMatch> datasets = [.. matched
            .OrderByDescending(m => m.Count)
            .Select(m => new QueryRunMatch(m.Plan.Entry.Name, m.Count))];
        return new QueryRunResult(null, total, datasets, rows, CollectHighlightTerms(query));
    }

    private static IReadOnlyList<string> CollectHighlightTerms(Query query)
    {
        List<string> terms = [];
        HashSet<string> seen = new(StringComparer.OrdinalIgnoreCase);
        foreach (QueryClause clause in query.Clauses)
        {
            if (clause.Op is not (MatchOp.Any or MatchOp.All))
            {
                continue;
            }
            foreach (string value in clause.Values)
            {
                if (value.Length > 0 && seen.Add(value))
                {
                    terms.Add(value);
                }
            }
        }
        return terms;
    }

    private sealed record Plan(DatasetEntry Entry, string PromptColumn, SqlFilter Filter);

    private static Plan DraftPlan(Query query, DatasetEntry entry)
    {
        ColumnSchema schema = DatasetManager.GetSchema(entry);
        string promptColumn = PromptColumnResolver.Resolve(
            query.PromptColumn, DatasetManager.GetConfiguredPromptColumn(entry.Name), schema);
        if (promptColumn is null)
        {
            return null;
        }
        List<ColumnInfo> tagColumns = TagColumnResolver.Resolve(DatasetManager.GetConfiguredTagColumns(entry.Name), schema, promptColumn);
        return new Plan(entry, promptColumn, SqlFilterBuilder.Build(query, schema, tagColumns));
    }
}
