using Xunit;

namespace Quarry.Tests;

public class SqlFilterBuilderTests
{
    private static ColumnSchema Schema(params (string name, ColumnKind kind)[] cols)
    {
        return new ColumnSchema(cols.Select(c => new ColumnInfo(c.name, c.kind)));
    }

    private static SqlFilter Build(string data, params (string, ColumnKind)[] cols)
    {
        return SqlFilterBuilder.Build(QueryParser.Parse(data), Schema(cols));
    }

    private static SqlFilter BuildWithTags(string data, string[] tagColumns, params (string, ColumnKind)[] cols)
    {
        ColumnSchema schema = Schema(cols);
        List<ColumnInfo> tags = [.. tagColumns.Select(t => { schema.TryGet(t, out ColumnInfo c); return c; })];
        return SqlFilterBuilder.Build(QueryParser.Parse(data), schema, tags);
    }

    private static SqlFilter BuildNumeric(string data, params (string name, ColumnKind kind, bool numeric)[] cols)
    {
        ColumnSchema schema = new(cols.Select(c => new ColumnInfo(c.name, c.kind, c.numeric)));
        return SqlFilterBuilder.Build(QueryParser.Parse(data), schema);
    }

    [Fact]
    public void NoFilter_ReturnsEmpty()
    {
        SqlFilter f = Build("prompts/1girl");
        Assert.True(f.IsEmpty);
        Assert.Empty(f.Parameters);
        Assert.Equal("", f.WhereClause);
    }

    // --- Scalar/text columns: case-insensitive substring -------------------------------------------
    // The value is lowercased into the bound parameter (not via a SQL lower() on the placeholder), and the
    // column side is lowercased too -- via lower(col) here, since these schemas have no `_lc` companion.

    [Fact]
    public void ScalarAny_BuildsContainsOr()
    {
        SqlFilter f = Build("p[source=civitai,local]", ("source", ColumnKind.Scalar));
        Assert.Equal(
            "(contains(lower(\"source\"), $p0) OR contains(lower(\"source\"), $p1))",
            f.WhereClause);
        Assert.Equal(new[] { "p0", "p1" }, f.Parameters.Select(p => p.Name));
        Assert.Equal(new[] { "civitai", "local" }, f.Parameters.Select(p => p.Value));
    }

    [Fact]
    public void ScalarAll_BuildsContainsAnd()
    {
        SqlFilter f = Build("p[Prompt==girl,red]", ("Prompt", ColumnKind.Scalar));
        Assert.Equal(
            "(contains(lower(\"Prompt\"), $p0) AND contains(lower(\"Prompt\"), $p1))",
            f.WhereClause);
    }

    [Fact]
    public void ScalarNone_BuildsNotContains()
    {
        SqlFilter f = Build("p[Prompt!=nsfw]", ("Prompt", ColumnKind.Scalar));
        Assert.Equal("NOT (contains(lower(\"Prompt\"), $p0))", f.WhereClause);
        Assert.Equal("nsfw", Assert.Single(f.Parameters).Value);
    }

    [Fact]
    public void ScalarAny_SingleValue()
    {
        SqlFilter f = Build("p[Prompt=girl]", ("Prompt", ColumnKind.Scalar));
        Assert.Equal("(contains(lower(\"Prompt\"), $p0))", f.WhereClause);
    }

    // --- Lowercased companion column (`<col>__lc`): matched directly so an NGRAM index is used --------

    [Fact]
    public void Scalar_WithLowercaseCompanion_MatchesCompanionDirectly()
    {
        // When an NGRAM-indexed `<col>__lc` companion exists, the substring match runs against it with no lower()
        // wrapper, so Lance's NGRAM scalar index on the companion can be pushed down.
        ColumnSchema schema = new(
        [
            new ColumnInfo("Prompt", ColumnKind.Scalar),
            new ColumnInfo("Prompt__lc", ColumnKind.Scalar, hasNgramIndex: true),
        ]);
        SqlFilter f = SqlFilterBuilder.Build(QueryParser.Parse("p[Prompt=girl]"), schema);
        Assert.Equal("(contains(\"Prompt__lc\", $p0))", f.WhereClause);
    }

    [Fact]
    public void Scalar_UnindexedLowercaseCompanion_FallsBackToLower()
    {
        // A `<col>__lc` companion is trusted ONLY when it carries an NGRAM index (i.e. one our indexer built, which
        // is guaranteed to hold lower(col)). An unindexed look-alike must be ignored, so a coincidentally named
        // user column can never be searched in place of the real one.
        ColumnSchema schema = new(
        [
            new ColumnInfo("Prompt", ColumnKind.Scalar),
            new ColumnInfo("Prompt__lc", ColumnKind.Scalar),
        ]);
        SqlFilter f = SqlFilterBuilder.Build(QueryParser.Parse("p[Prompt=girl]"), schema);
        Assert.Equal("(contains(lower(\"Prompt\"), $p0))", f.WhereClause);
    }

    [Fact]
    public void Scalar_LowercaseCompanionLookup_IsCaseInsensitive()
    {
        // The companion is found case-insensitively, matching how column names resolve generally.
        ColumnSchema schema = new(
        [
            new ColumnInfo("Prompt", ColumnKind.Scalar),
            new ColumnInfo("prompt__lc", ColumnKind.Scalar, hasNgramIndex: true),
        ]);
        SqlFilter f = SqlFilterBuilder.Build(QueryParser.Parse("p[prompt=girl]"), schema);
        Assert.Equal("(contains(\"prompt__lc\", $p0))", f.WhereClause);
    }

    [Fact]
    public void Scalar_ListCompanion_IsIgnored_FallsBackToLower()
    {
        // A companion that is a list (not a scalar string) can't back a scalar substring match, so we fall back.
        SqlFilter f = Build("p[Prompt=girl]", ("Prompt", ColumnKind.Scalar), ("Prompt__lc", ColumnKind.List));
        Assert.Equal("(contains(lower(\"Prompt\"), $p0))", f.WhereClause);
    }

    [Fact]
    public void MatchValue_IsLowercased_ForCaseInsensitiveMatching()
    {
        // Case-insensitivity is achieved by lowercasing the value into the bound parameter.
        SqlFilter f = Build("p[Prompt=GiRl]", ("Prompt", ColumnKind.Scalar));
        Assert.Equal("girl", Assert.Single(f.Parameters).Value);
    }

    [Fact]
    public void Scalar_WithInPlaceNgramIndex_MatchesColumnRaw()
    {
        // No `_lc` companion, but the column itself carries an NGRAM index (built on already-lowercase data) ->
        // match it raw, with no lower() wrapper, so the index is pushed down.
        ColumnSchema schema = new([new ColumnInfo("prompt", ColumnKind.Scalar, hasNgramIndex: true)]);
        SqlFilter f = SqlFilterBuilder.Build(QueryParser.Parse("p[prompt=girl]"), schema);
        Assert.Equal("(contains(\"prompt\", $p0))", f.WhereClause);
    }

    [Fact]
    public void Scalar_LowercaseCompanion_PreferredOverInPlaceIndex()
    {
        // When both exist, the `_lc` companion wins (it is guaranteed lowercased text).
        ColumnSchema schema = new(
        [
            new ColumnInfo("Prompt", ColumnKind.Scalar, hasNgramIndex: true),
            new ColumnInfo("Prompt__lc", ColumnKind.Scalar, hasNgramIndex: true),
        ]);
        SqlFilter f = SqlFilterBuilder.Build(QueryParser.Parse("p[Prompt=girl]"), schema);
        Assert.Equal("(contains(\"Prompt__lc\", $p0))", f.WhereClause);
    }

    [Fact]
    public void ShortValue_BypassesNgramIndex_UsesScan()
    {
        // A 1-2 char term can't be answered by a trigram index (it silently returns nothing), so it must match
        // lower(col) and scan -- even when an indexed companion exists. >=3 chars uses the companion.
        ColumnSchema schema = new(
        [
            new ColumnInfo("prompt", ColumnKind.Scalar),
            new ColumnInfo("prompt__lc", ColumnKind.Scalar, hasNgramIndex: true),
        ]);
        Assert.Equal("(contains(lower(\"prompt\"), $p0))",
            SqlFilterBuilder.Build(QueryParser.Parse("p[prompt=ab]"), schema).WhereClause);
        Assert.Equal("(contains(\"prompt__lc\", $p0))",
            SqlFilterBuilder.Build(QueryParser.Parse("p[prompt=abc]"), schema).WhereClause);
    }

    [Fact]
    public void MixedLengthValues_RoutePerValue()
    {
        ColumnSchema schema = new(
        [
            new ColumnInfo("prompt", ColumnKind.Scalar),
            new ColumnInfo("prompt__lc", ColumnKind.Scalar, hasNgramIndex: true),
        ]);
        Assert.Equal("(contains(lower(\"prompt\"), $p0) OR contains(\"prompt__lc\", $p1))",
            SqlFilterBuilder.Build(QueryParser.Parse("p[prompt=ab,abc]"), schema).WhereClause);
    }

    // --- List columns: case-insensitive substring against each element ------------------------------

    [Fact]
    public void ListAny_BuildsPerElementContainsOr()
    {
        SqlFilter f = Build("p[tags=a,b]", ("tags", ColumnKind.List));
        Assert.Equal(
            "(len(list_filter(\"tags\", x -> contains(lower(x), $p0))) > 0 OR len(list_filter(\"tags\", x -> contains(lower(x), $p1))) > 0)",
            f.WhereClause);
    }

    [Fact]
    public void ListAll_BuildsPerElementContainsAnd()
    {
        SqlFilter f = Build("p[tags==a,b]", ("tags", ColumnKind.List));
        Assert.Equal(
            "(len(list_filter(\"tags\", x -> contains(lower(x), $p0))) > 0 AND len(list_filter(\"tags\", x -> contains(lower(x), $p1))) > 0)",
            f.WhereClause);
    }

    [Fact]
    public void ListNone_BuildsNotPerElementContains()
    {
        SqlFilter f = Build("p[tags!=nsfw]", ("tags", ColumnKind.List));
        Assert.Equal(
            "NOT (len(list_filter(\"tags\", x -> contains(lower(x), $p0))) > 0)",
            f.WhereClause);
    }

    // --- Ordered comparisons: numbers compare directly; text compares by character length -----------

    [Fact]
    public void TextGreaterOrEqual_UsesCharacterLength()
    {
        SqlFilter f = BuildNumeric("p[prompt+=5]", ("prompt", ColumnKind.Scalar, false));
        Assert.Equal("(length(\"prompt\") >= TRY_CAST($p0 AS BIGINT))", f.WhereClause);
        Assert.Equal("5", Assert.Single(f.Parameters).Value);
    }

    [Fact]
    public void TextLessOrEqual_UsesCharacterLength()
    {
        SqlFilter f = BuildNumeric("p[tags-=50]", ("tags", ColumnKind.Scalar, false));
        Assert.Equal("(length(\"tags\") <= TRY_CAST($p0 AS BIGINT))", f.WhereClause);
        Assert.Equal("50", Assert.Single(f.Parameters).Value);
    }

    [Fact]
    public void TextLengthComparison_FractionalBoundsRoundInTheSafeDirection()
    {
        Assert.Equal(
            "(length(\"prompt\") >= TRY_CAST(CEIL(TRY_CAST($p0 AS DOUBLE)) AS BIGINT))",
            BuildNumeric("p[prompt+=5.1]", ("prompt", ColumnKind.Scalar, false)).WhereClause);
        Assert.Equal(
            "(length(\"prompt\") <= TRY_CAST(FLOOR(TRY_CAST($p0 AS DOUBLE)) AS BIGINT))",
            BuildNumeric("p[prompt-=5.9]", ("prompt", ColumnKind.Scalar, false)).WhereClause);
    }

    [Fact]
    public void NumericGreaterOrEqual_BuildsComparison()
    {
        // Quarry syntax `+=` ("at least") compiles to SQL `>=` against the number column.
        SqlFilter f = BuildNumeric("p[score+=0.8]", ("score", ColumnKind.Scalar, true));
        Assert.Equal("(\"score\" >= TRY_CAST($p0 AS DOUBLE))", f.WhereClause);
        Assert.Equal("0.8", Assert.Single(f.Parameters).Value);
    }

    [Fact]
    public void NumericLessOrEqual_BuildsComparison()
    {
        // Quarry syntax `-=` ("at most") compiles to SQL `<=`.
        SqlFilter f = BuildNumeric("p[width-=768]", ("width", ColumnKind.Scalar, true));
        Assert.Equal("(\"width\" <= TRY_CAST($p0 AS DOUBLE))", f.WhereClause);
        Assert.Equal("768", Assert.Single(f.Parameters).Value);
    }

    [Fact]
    public void NumericComparison_MultipleValues_OrsThem()
    {
        SqlFilter f = BuildNumeric("p[score+=1,2]", ("score", ColumnKind.Scalar, true));
        Assert.Equal(
            "(\"score\" >= TRY_CAST($p0 AS DOUBLE) OR \"score\" >= TRY_CAST($p1 AS DOUBLE))",
            f.WhereClause);
        Assert.Equal(new[] { "1", "2" }, f.Parameters.Select(p => p.Value));
    }

    [Fact]
    public void NumericComparison_NegativeBound_StaysOnValueSide()
    {
        SqlFilter f = BuildNumeric("p[temp-=-5]", ("temp", ColumnKind.Scalar, true));
        Assert.Equal("(\"temp\" <= TRY_CAST($p0 AS DOUBLE))", f.WhereClause);
        Assert.Equal("-5", Assert.Single(f.Parameters).Value);
    }

    [Fact]
    public void NumericComparison_QuotesIdentifier_AndBindsValue()
    {
        // The value lands in a bound parameter (never the SQL text), and the column name is quote-escaped.
        SqlFilter f = BuildNumeric("p[wei\"rd+=5]", ("wei\"rd", ColumnKind.Scalar, true));
        Assert.Equal("(\"wei\"\"rd\" >= TRY_CAST($p0 AS DOUBLE))", f.WhereClause);
        Assert.Equal("5", Assert.Single(f.Parameters).Value);
    }

    [Fact]
    public void NumericComparison_NotLowercased()
    {
        // Numeric bounds are cast, not substring-matched, so they are bound verbatim (no case folding).
        SqlFilter f = BuildNumeric("p[score+=1E5]", ("score", ColumnKind.Scalar, true));
        Assert.Equal("1E5", Assert.Single(f.Parameters).Value);
    }

    [Fact]
    public void NumericComparison_DefaultsToDoubleCast_WhenTypeUnknown()
    {
        // With no native type recorded, the cast falls back to DOUBLE (correct, just unindexed).
        SqlFilter f = BuildNumeric("p[score+=0.8]", ("score", ColumnKind.Scalar, true));
        Assert.Equal("(\"score\" >= TRY_CAST($p0 AS DOUBLE))", f.WhereClause);
    }

    [Fact]
    public void NumericComparison_CastsValueToColumnNativeType()
    {
        // Casting the value to the column's own type (here BIGINT) leaves the column un-wrapped so a BTREE index
        // is pushed down; a DOUBLE cast on a BIGINT column would wrap the column and defeat the index.
        ColumnSchema schema = new([new ColumnInfo("fav_count", ColumnKind.Scalar, isNumeric: true, numericType: "BIGINT")]);
        SqlFilter f = SqlFilterBuilder.Build(QueryParser.Parse("p[fav_count+=990]"), schema);
        Assert.Equal("(\"fav_count\" >= TRY_CAST($p0 AS BIGINT))", f.WhereClause);
    }

    [Fact]
    public void NumericComparison_FractionalBound_IntegerColumn_GreaterOrEqual_CeilsBound()
    {
        // "+=10.4" on a BIGINT column means "at least 10.4", i.e. >= 11. Casting 10.4 straight to BIGINT would
        // round to 10 and wrongly keep steps=10, so the bound is ceil'd. The column stays un-wrapped for BTREE.
        ColumnSchema schema = new([new ColumnInfo("steps", ColumnKind.Scalar, isNumeric: true, numericType: "BIGINT")]);
        SqlFilter f = SqlFilterBuilder.Build(QueryParser.Parse("p[steps+=10.4]"), schema);
        Assert.Equal("(\"steps\" >= TRY_CAST(CEIL(TRY_CAST($p0 AS DOUBLE)) AS BIGINT))", f.WhereClause);
    }

    [Fact]
    public void NumericComparison_FractionalBound_IntegerColumn_LessOrEqual_FloorsBound()
    {
        // "-=10.5" on a BIGINT column means "at most 10.5", i.e. <= 10. Casting 10.5 straight to BIGINT would
        // round to 11 and wrongly keep steps=11, so the bound is floor'd.
        ColumnSchema schema = new([new ColumnInfo("steps", ColumnKind.Scalar, isNumeric: true, numericType: "BIGINT")]);
        SqlFilter f = SqlFilterBuilder.Build(QueryParser.Parse("p[steps-=10.5]"), schema);
        Assert.Equal("(\"steps\" <= TRY_CAST(FLOOR(TRY_CAST($p0 AS DOUBLE)) AS BIGINT))", f.WhereClause);
    }

    [Fact]
    public void NumericComparison_IntegerBound_IntegerColumn_UsesPlainNativeCast()
    {
        // An integer-looking bound needs no rounding, so it keeps the plain (definitely index-friendly) native cast.
        ColumnSchema schema = new([new ColumnInfo("steps", ColumnKind.Scalar, isNumeric: true, numericType: "BIGINT")]);
        SqlFilter f = SqlFilterBuilder.Build(QueryParser.Parse("p[steps-=10]"), schema);
        Assert.Equal("(\"steps\" <= TRY_CAST($p0 AS BIGINT))", f.WhereClause);
    }

    [Fact]
    public void NumericComparison_FractionalBound_DecimalColumn_UsesPlainNativeCast()
    {
        // DECIMAL preserves the fraction, so no ceil/floor is needed -- the value is cast verbatim to the native
        // parenthesized type (which round-trips through the cache).
        ColumnSchema schema = new([new ColumnInfo("price", ColumnKind.Scalar, isNumeric: true, numericType: "DECIMAL(10,2)")]);
        SqlFilter f = SqlFilterBuilder.Build(QueryParser.Parse("p[price-=0.5]"), schema);
        Assert.Equal("(\"price\" <= TRY_CAST($p0 AS DECIMAL(10,2)))", f.WhereClause);
    }

    [Fact]
    public void NumericComparison_MixedWithTextClause_ParamsSequential()
    {
        SqlFilter f = BuildNumeric(
            "p[source=civitai;score+=0.8]",
            ("source", ColumnKind.Scalar, false),
            ("score", ColumnKind.Scalar, true));
        Assert.Equal(
            "(contains(lower(\"source\"), $p0)) AND (\"score\" >= TRY_CAST($p1 AS DOUBLE))",
            f.WhereClause);
        Assert.Equal(new[] { "civitai", "0.8" }, f.Parameters.Select(p => p.Value));
    }

    [Fact]
    public void TextComparison_MixedWithNumericClause_ParamsSequential()
    {
        SqlFilter f = BuildNumeric(
            "p[prompt-=50;score+=0.8]",
            ("prompt", ColumnKind.Scalar, false),
            ("score", ColumnKind.Scalar, true));
        Assert.Equal(
            "(length(\"prompt\") <= TRY_CAST($p0 AS BIGINT)) AND (\"score\" >= TRY_CAST($p1 AS DOUBLE))",
            f.WhereClause);
        Assert.Equal(new[] { "50", "0.8" }, f.Parameters.Select(p => p.Value));
    }

    [Fact]
    public void NumericComparison_OnListColumn_Throws()
    {
        Assert.Throws<NonNumericComparisonException>(
            () => BuildNumeric("p[tags-=5]", ("tags", ColumnKind.List, false)));
    }

    [Fact]
    public void TextComparison_OnMergedTagsKeyword_UsesConfiguredScalarColumns()
    {
        SqlFilter f = BuildWithTags(
            "p[tags-=50]",
            ["bar", "baz"],
            ("bar", ColumnKind.Scalar),
            ("baz", ColumnKind.Scalar));
        Assert.Equal(
            "((length(\"bar\") <= TRY_CAST($p0 AS BIGINT) OR length(\"baz\") <= TRY_CAST($p0 AS BIGINT)))",
            f.WhereClause);
        Assert.Equal("50", Assert.Single(f.Parameters).Value);
    }

    [Fact]
    public void Comparison_OnMergedTagsKeyword_WithListColumn_Throws()
    {
        Assert.Throws<NonNumericComparisonException>(
            () => BuildWithTags("p[tags+=5]", ["bar"], ("bar", ColumnKind.List)));
    }

    // --- Mixed / general ----------------------------------------------------------------------------

    [Fact]
    public void MultipleClauses_JoinedWithAnd_ParamsSequential()
    {
        SqlFilter f = Build(
            "p[tags=a,b;source=civitai]",
            ("tags", ColumnKind.List),
            ("source", ColumnKind.Scalar));
        Assert.Equal(
            "(len(list_filter(\"tags\", x -> contains(lower(x), $p0))) > 0 OR len(list_filter(\"tags\", x -> contains(lower(x), $p1))) > 0) AND (contains(lower(\"source\"), $p2))",
            f.WhereClause);
        Assert.Equal(new[] { "a", "b", "civitai" }, f.Parameters.Select(p => p.Value));
    }

    // --- tags keyword: configured tag columns searched as one merged column -------------------------

    [Fact]
    public void TagsKeyword_SingleScalarColumn_BuildsContains()
    {
        SqlFilter f = BuildWithTags("p[tags=1girl]", ["bar"], ("foo", ColumnKind.Scalar), ("bar", ColumnKind.Scalar));
        Assert.Equal("(contains(lower(\"bar\"), $p0))", f.WhereClause);
        Assert.Equal("1girl", Assert.Single(f.Parameters).Value);
    }

    [Fact]
    public void TagsKeyword_ScalarColumnWithCompanion_MatchesCompanion()
    {
        // A configured tag column also honors its NGRAM-indexed `<col>__lc` companion, so merged-tag search is
        // indexed too.
        ColumnSchema schema = new(
        [
            new ColumnInfo("bar", ColumnKind.Scalar),
            new ColumnInfo("bar__lc", ColumnKind.Scalar, hasNgramIndex: true),
        ]);
        schema.TryGet("bar", out ColumnInfo bar);
        SqlFilter f = SqlFilterBuilder.Build(QueryParser.Parse("p[tags=1girl]"), schema, [bar]);
        Assert.Equal("(contains(\"bar__lc\", $p0))", f.WhereClause);
    }

    [Fact]
    public void TagsKeyword_TwoScalarColumns_Any_OrsAcrossColumns()
    {
        SqlFilter f = BuildWithTags("p[tags=1girl]", ["bar", "baz"], ("bar", ColumnKind.Scalar), ("baz", ColumnKind.Scalar));
        Assert.Equal(
            "((contains(lower(\"bar\"), $p0) OR contains(lower(\"baz\"), $p0)))",
            f.WhereClause);
    }

    [Fact]
    public void TagsKeyword_TwoColumns_All_IsCumulativePerValue()
    {
        SqlFilter f = BuildWithTags("p[tags==1girl,solo]", ["bar", "baz"], ("bar", ColumnKind.Scalar), ("baz", ColumnKind.Scalar));
        Assert.Equal(
            "((contains(lower(\"bar\"), $p0) OR contains(lower(\"baz\"), $p0)) AND (contains(lower(\"bar\"), $p1) OR contains(lower(\"baz\"), $p1)))",
            f.WhereClause);
        Assert.Equal(new[] { "1girl", "solo" }, f.Parameters.Select(p => p.Value));
    }

    [Fact]
    public void TagsKeyword_None_NegatesTheMergedMatch()
    {
        SqlFilter f = BuildWithTags("p[tags!=nsfw]", ["bar", "baz"], ("bar", ColumnKind.Scalar), ("baz", ColumnKind.Scalar));
        Assert.Equal(
            "NOT ((contains(lower(\"bar\"), $p0) OR contains(lower(\"baz\"), $p0)))",
            f.WhereClause);
    }

    [Fact]
    public void TagsKeyword_MixedScalarAndListColumns()
    {
        SqlFilter f = BuildWithTags("p[tags=1girl]", ["bar", "baz"], ("bar", ColumnKind.Scalar), ("baz", ColumnKind.List));
        Assert.Equal(
            "((contains(lower(\"bar\"), $p0) OR len(list_filter(\"baz\", x -> contains(lower(x), $p0))) > 0))",
            f.WhereClause);
    }

    [Fact]
    public void TagsKeyword_NoConfiguredColumns_FallsBackToLiteralColumn()
    {
        // With no tag columns configured, `tags` behaves as a literal column name (today's behavior).
        SqlFilter f = BuildWithTags("p[tags=a,b]", [], ("tags", ColumnKind.List));
        Assert.Equal(
            "(len(list_filter(\"tags\", x -> contains(lower(x), $p0))) > 0 OR len(list_filter(\"tags\", x -> contains(lower(x), $p1))) > 0)",
            f.WhereClause);
    }

    [Fact]
    public void UnknownColumn_Throws()
    {
        Assert.Throws<QueryException>(() => Build("p[missing=a]", ("tags", ColumnKind.List)));
    }

    [Fact]
    public void ColumnLookup_IsCaseInsensitive_QuotesCanonicalName()
    {
        SqlFilter f = Build("p[TAGS=a]", ("tags", ColumnKind.List));
        Assert.Equal("(len(list_filter(\"tags\", x -> contains(lower(x), $p0))) > 0)", f.WhereClause);
    }

    [Fact]
    public void IdentifierWithEmbeddedQuote_IsEscaped()
    {
        SqlFilter f = Build("p[wei\"rd=a]", ("wei\"rd", ColumnKind.Scalar));
        Assert.Equal("(contains(lower(\"wei\"\"rd\"), $p0))", f.WhereClause);
    }

    [Fact]
    public void ValuesAreBound_NotInterpolated()
    {
        // A value carrying SQL metacharacters must land verbatim (bar case folding) in a bound parameter,
        // never the SQL text.
        SqlFilter f = Build("p[source=x' OR '1'='1]", ("source", ColumnKind.Scalar));
        Assert.Equal("(contains(lower(\"source\"), $p0))", f.WhereClause);
        Assert.Equal("x' or '1'='1", Assert.Single(f.Parameters).Value);
    }
}
