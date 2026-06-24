using Newtonsoft.Json.Linq;
using Xunit;

namespace Quarry.Tests;

public class ImageSearchFilterBuilderTests
{
    private static SqlFilter Build(string json) => ImageSearchFilterBuilder.Build(JArray.Parse(json));

    [Fact]
    public void Empty_ReturnsNone()
    {
        Assert.True(ImageSearchFilterBuilder.Build(null).IsEmpty);
        Assert.True(Build("[]").IsEmpty);
    }

    [Fact]
    public void TextAny_BuildsContains()
    {
        // `=` mirrors the prompt query: substring "match any".
        SqlFilter f = Build("""[{"field":"prompt","op":"=","value":"cat"}]""");
        Assert.Equal("contains(lower(\"prompt\"), $p0)", f.WhereClause);
        Assert.Equal("p0", f.Parameters[0].Name);
        Assert.Equal("cat", f.Parameters[0].Value);
    }

    [Fact]
    public void TextAny_WithLowercaseCompanion_MatchesCompanionAndLowercasesValue()
    {
        // When the index has an NGRAM-indexed `<col>__lc` companion, the image browser matches it directly (NGRAM
        // pushdown) and lowercases the value app-side -- the same contract as the wildcard filter builder.
        ColumnSchema schema = new(
        [
            new ColumnInfo("prompt", ColumnKind.Scalar),
            new ColumnInfo("prompt__lc", ColumnKind.Scalar, hasNgramIndex: true),
        ]);
        SqlFilter f = ImageSearchFilterBuilder.Build(JArray.Parse("""[{"field":"prompt","op":"=","value":"Cat"}]"""), schema);
        Assert.Equal("contains(\"prompt__lc\", $p0)", f.WhereClause);
        Assert.Equal("cat", f.Parameters[0].Value);
    }

    [Fact]
    public void TextOperators_WithCompanion_RouteToCompanionAndLowercaseValue()
    {
        // Companion routing + app-side value lowercasing is shared by every text operator.
        ColumnSchema schema = new(
        [
            new ColumnInfo("prompt", ColumnKind.Scalar),
            new ColumnInfo("prompt__lc", ColumnKind.Scalar, hasNgramIndex: true),
        ]);
        SqlFilter all = ImageSearchFilterBuilder.Build(JArray.Parse("""[{"field":"prompt","op":"==","value":"Cat"}]"""), schema);
        Assert.Equal("contains(\"prompt__lc\", $p0)", all.WhereClause);
        Assert.Equal("cat", all.Parameters[0].Value);

        SqlFilter none = ImageSearchFilterBuilder.Build(JArray.Parse("""[{"field":"prompt","op":"!=","value":"Cat"}]"""), schema);
        Assert.Equal("NOT contains(\"prompt__lc\", $p0)", none.WhereClause);
    }

    [Fact]
    public void TextAny_UnindexedCompanion_FallsBackToLower()
    {
        // Without an NGRAM index on the companion, the image browser must not redirect to it -- it scans lower(col).
        ColumnSchema schema = new(
        [
            new ColumnInfo("prompt", ColumnKind.Scalar),
            new ColumnInfo("prompt__lc", ColumnKind.Scalar),
        ]);
        SqlFilter f = ImageSearchFilterBuilder.Build(JArray.Parse("""[{"field":"prompt","op":"=","value":"Cat"}]"""), schema);
        Assert.Equal("contains(lower(\"prompt\"), $p0)", f.WhereClause);
    }

    [Fact]
    public void TextAny_ShortValue_BypassesCompanionIndex()
    {
        // 1-2 char terms can't use a trigram index; they must scan lower(col) even when a companion exists.
        ColumnSchema schema = new(
        [
            new ColumnInfo("prompt", ColumnKind.Scalar),
            new ColumnInfo("prompt__lc", ColumnKind.Scalar, hasNgramIndex: true),
        ]);
        SqlFilter f = ImageSearchFilterBuilder.Build(JArray.Parse("""[{"field":"prompt","op":"=","value":"ab"}]"""), schema);
        Assert.Equal("contains(lower(\"prompt\"), $p0)", f.WhereClause);
    }

    [Fact]
    public void TextAny_MultipleValues_OrsContains()
    {
        // `=` over comma-separated values is "match ANY", exactly like `<q:prompts[prompt=cat,dog]>`.
        SqlFilter f = Build("""[{"field":"prompt","op":"=","value":"cat, dog"}]""");
        Assert.Equal("(contains(lower(\"prompt\"), $p0) OR contains(lower(\"prompt\"), $p1))", f.WhereClause);
        Assert.Equal(new[] { "cat", "dog" }, f.Parameters.Select(p => p.Value));
    }

    [Fact]
    public void TextAll_MultipleValues_AndsContains()
    {
        // `==` over comma-separated values is "match ALL".
        SqlFilter f = Build("""[{"field":"prompt","op":"==","value":"cat, dog"}]""");
        Assert.Equal("(contains(lower(\"prompt\"), $p0) AND contains(lower(\"prompt\"), $p1))", f.WhereClause);
        Assert.Equal(new[] { "cat", "dog" }, f.Parameters.Select(p => p.Value));
    }

    [Fact]
    public void TextNone_MultipleValues_NegatesOr()
    {
        // `!=` over comma-separated values is "match NONE".
        SqlFilter f = Build("""[{"field":"prompt","op":"!=","value":"cat, dog"}]""");
        Assert.Equal("NOT (contains(lower(\"prompt\"), $p0) OR contains(lower(\"prompt\"), $p1))", f.WhereClause);
    }

    [Fact]
    public void TextAll_SingleValue_StaysUnparenthesised()
    {
        // One value collapses to a bare contains -- identical to `=`, no redundant parentheses.
        SqlFilter f = Build("""[{"field":"prompt","op":"==","value":"cat"}]""");
        Assert.Equal("contains(lower(\"prompt\"), $p0)", f.WhereClause);
    }

    [Fact]
    public void NumberAtLeast_BuildsCastComparison()
    {
        // `+=` is the prompt query's "at least" (>=).
        SqlFilter f = Build("""[{"field":"steps","op":"+=","value":"20"}]""");
        Assert.Equal("\"steps\" >= CAST($p0 AS DOUBLE)", f.WhereClause);
        Assert.Equal("20", f.Parameters[0].Value);
    }

    [Fact]
    public void NumberAtMost_BuildsCastComparison()
    {
        // `-=` is the prompt query's "at most" (<=).
        SqlFilter f = Build("""[{"field":"width","op":"-=","value":"768"}]""");
        Assert.Equal("\"width\" <= CAST($p0 AS DOUBLE)", f.WhereClause);
    }

    [Fact]
    public void NumberEquals_SubstringMatchesTextForm()
    {
        // `=` on a number is a substring match on its text form, mirroring the prompt query. lower() can't take a
        // numeric column directly, so it is cast to VARCHAR first.
        SqlFilter f = Build("""[{"field":"steps","op":"=","value":"20"}]""");
        Assert.Equal("contains(lower(CAST(\"steps\" AS VARCHAR)), $p0)", f.WhereClause);
        Assert.Equal("20", f.Parameters[0].Value);
    }

    [Fact]
    public void NumberAll_MultipleValues_AndsSubstring()
    {
        SqlFilter f = Build("""[{"field":"steps","op":"==","value":"2, 5"}]""");
        Assert.Equal(
            "(contains(lower(CAST(\"steps\" AS VARCHAR)), $p0) AND contains(lower(CAST(\"steps\" AS VARCHAR)), $p1))",
            f.WhereClause);
    }

    [Fact]
    public void ListAny_BuildsListFilter()
    {
        SqlFilter f = Build("""[{"field":"loras","op":"=","value":"foo"}]""");
        Assert.Equal("len(list_filter(\"loras\", x -> contains(lower(x), $p0))) > 0", f.WhereClause);
    }

    [Fact]
    public void ListAll_MultipleValues_AndsListFilters()
    {
        SqlFilter f = Build("""[{"field":"loras","op":"==","value":"foo, bar"}]""");
        Assert.Equal(
            "(len(list_filter(\"loras\", x -> contains(lower(x), $p0))) > 0 AND len(list_filter(\"loras\", x -> contains(lower(x), $p1))) > 0)",
            f.WhereClause);
    }

    [Fact]
    public void BoolIsTrue_NoParameter()
    {
        SqlFilter f = Build("""[{"field":"is_starred","op":"is_true","value":""}]""");
        Assert.Equal("\"is_starred\" = TRUE", f.WhereClause);
        Assert.Empty(f.Parameters);
    }

    [Fact]
    public void DiscoveredField_UsesJsonExtractSubstring()
    {
        SqlFilter f = Build("""[{"field":"scheduler","op":"=","value":"karras"}]""");
        Assert.Equal("contains(lower(json_extract_string(\"meta_json\", '$.\"scheduler\"')), $p0)", f.WhereClause);
        Assert.Equal("karras", f.Parameters[0].Value);
    }

    [Fact]
    public void DiscoveredAll_AndsJsonExtractContains()
    {
        SqlFilter f = Build("""[{"field":"scheduler","op":"==","value":"kar, ras"}]""");
        Assert.Equal(
            "(contains(lower(json_extract_string(\"meta_json\", '$.\"scheduler\"')), $p0) AND contains(lower(json_extract_string(\"meta_json\", '$.\"scheduler\"')), $p1))",
            f.WhereClause);
    }

    [Fact]
    public void DiscoveredNumeric_CastsJsonExtract()
    {
        SqlFilter f = Build("""[{"field":"clipskip","op":"+=","value":"2"}]""");
        Assert.Equal("TRY_CAST(json_extract_string(\"meta_json\", '$.\"clipskip\"') AS DOUBLE) >= CAST($p0 AS DOUBLE)", f.WhereClause);
    }

    [Fact]
    public void MultipleRows_JoinedWithAnd()
    {
        SqlFilter f = Build("""[{"field":"model","op":"=","value":"sdxl"},{"field":"steps","op":"+=","value":"10"}]""");
        Assert.Equal("contains(lower(\"model\"), $p0) AND \"steps\" >= CAST($p1 AS DOUBLE)", f.WhereClause);
        Assert.Equal(2, f.Parameters.Count);
    }

    [Fact]
    public void UnknownOpAndMissingFieldRows_Skipped()
    {
        // The backend keeps the one valid row (empty values are a legitimate query and are pre-filtered client-side);
        // it drops the unknown-operator row and the row with no field.
        SqlFilter f = Build("""[{"field":"prompt","op":"=","value":"keep"},{"field":"prompt","op":"bogus","value":"x"},{"field":"","op":"=","value":"y"}]""");
        Assert.Equal("contains(lower(\"prompt\"), $p0)", f.WhereClause);
        Assert.Single(f.Parameters);
        Assert.Equal("keep", f.Parameters[0].Value);
    }

    [Fact]
    public void DiscoveredFieldName_IsSafelyEscaped()
    {
        // A malicious field name must not break out of the JSON path literal.
        SqlFilter f = Build("""[{"field":"a\"b","op":"=","value":"v"}]""");
        Assert.Contains("json_extract_string(\"meta_json\", '$.\"a\\\"b\"')", f.WhereClause);
    }

    [Fact]
    public void NumberComparison_NonNumericValue_IsDropped()
    {
        // A non-numeric value on a numeric comparison must never reach CAST($p AS DOUBLE), which would 500 the
        // search; the term is dropped instead. Covers core + discovered. (Substring `=` accepts any value, so it
        // is not affected.)
        Assert.True(Build("""[{"field":"steps","op":"+=","value":"abc"}]""").IsEmpty);
        Assert.True(Build("""[{"field":"clipskip","op":"-=","value":"not-a-number"}]""").IsEmpty);
    }

    [Fact]
    public void AtLeastOnTextField_IsDroppedWithAWarning()
    {
        // +=/-= are numeric-only. On a known non-numeric column the term is skipped and the user is warned, rather
        // than silently matching nothing.
        SqlFilter f = ImageSearchFilterBuilder.Build(
            JArray.Parse("""[{"field":"prompt","op":"+=","value":"5"}]"""), null, out List<string> warnings);
        Assert.True(f.IsEmpty);
        string warning = Assert.Single(warnings);
        Assert.Contains("Prompt", warning);
        Assert.Contains("+=", warning);
    }

    [Fact]
    public void AtMostOnListField_IsDroppedWithAWarning()
    {
        SqlFilter f = ImageSearchFilterBuilder.Build(
            JArray.Parse("""[{"field":"loras","op":"-=","value":"5"}]"""), null, out List<string> warnings);
        Assert.True(f.IsEmpty);
        Assert.Single(warnings);
    }

    [Fact]
    public void AtLeastOnNumberField_DoesNotWarn()
    {
        // The numeric operators are valid on number fields, so a valid filter must never produce a warning.
        SqlFilter f = ImageSearchFilterBuilder.Build(
            JArray.Parse("""[{"field":"steps","op":"+=","value":"20"}]"""), null, out List<string> warnings);
        Assert.Equal("\"steps\" >= CAST($p0 AS DOUBLE)", f.WhereClause);
        Assert.Empty(warnings);
    }

    [Fact]
    public void OperatorsByType_AdvertisesExactlyTheOperatorsTheBuilderAccepts()
    {
        // The UI renders its dropdowns from this catalog, so it must list exactly the operators each type supports.
        Assert.Equal(new[] { "=", "==", "!=" },
            ImageSearchFilterBuilder.OperatorsByType["text"].Select(o => o.Value));
        Assert.Equal(new[] { "=", "==", "!=", "+=", "-=" },
            ImageSearchFilterBuilder.OperatorsByType["number"].Select(o => o.Value));
        Assert.Equal(new[] { "=", "==", "!=" },
            ImageSearchFilterBuilder.OperatorsByType["list"].Select(o => o.Value));
        Assert.Equal(new[] { "is_true", "is_false" },
            ImageSearchFilterBuilder.OperatorsByType["bool"].Select(o => o.Value));
        Assert.Equal(new[] { "=", "==", "!=", "+=", "-=" },
            ImageSearchFilterBuilder.OperatorsByType["discovered"].Select(o => o.Value));
    }
}
