import XCTest
@testable import InventoryApp

@MainActor
final class ItemValuationViewModelTests: XCTestCase {
    private func valuation(
        for itemId: UUID,
        price: Price? = Price(amount: 45.5, currency: "USD"),
        sources: [ValuationSource] = []
    ) -> Valuation {
        Valuation(
            itemId: itemId,
            name: "Cordless Drill",
            price: price,
            sources: sources,
            model: "gemini-2.5-flash",
            valuedAt: Date(timeIntervalSince1970: 0)
        )
    }

    func testStartsIdleAndIssuesNoRequest() {
        let item = Item.fixture()
        let service = StubInventoryService(items: [item])
        let viewModel = ItemValuationViewModel(itemId: item.id, service: service)

        XCTAssertEqual(viewModel.state, .idle)
        XCTAssertTrue(
            service.calls.isEmpty,
            "valuation costs an upstream call, so nothing fires until asked"
        )
    }

    func testValuateLoadsAndExposesThePrice() async {
        let item = Item.fixture()
        let service = StubInventoryService(items: [item])
        let expected = valuation(
            for: item.id,
            sources: [
                ValuationSource(
                    uri: URL(string: "https://example.com/listing")!,
                    title: "Drill listing"
                )
            ]
        )
        service.setValuation(expected)
        let viewModel = ItemValuationViewModel(itemId: item.id, service: service)

        await viewModel.valuate()

        XCTAssertEqual(viewModel.state, .loaded(expected))
        XCTAssertEqual(service.calls, [.valuate(item.id)])

        guard case let .loaded(result) = viewModel.state else {
            return XCTFail("expected a loaded state, got \(viewModel.state)")
        }
        XCTAssertEqual(result.price?.amount, 45.5)
        XCTAssertEqual(result.sources.first?.displayTitle, "Drill listing")
    }

    func testANullPriceIsAResultNotAFailure() async {
        let item = Item.fixture()
        let service = StubInventoryService(items: [item])
        service.setValuation(valuation(for: item.id, price: nil))
        let viewModel = ItemValuationViewModel(itemId: item.id, service: service)

        await viewModel.valuate()

        guard case let .loaded(result) = viewModel.state else {
            return XCTFail("a null price must still load, got \(viewModel.state)")
        }
        XCTAssertNil(result.price)
        XCTAssertEqual(result.name, "Cordless Drill")
    }

    func testAnUnconfiguredServerSurfacesItsMessage() async {
        let item = Item.fixture()
        let service = StubInventoryService(items: [item])
        service.setFailure(
            .api(
                status: 503,
                code: "valuation_not_configured",
                message: "Valuation is not configured on this server."
            )
        )
        let viewModel = ItemValuationViewModel(itemId: item.id, service: service)

        await viewModel.valuate()

        XCTAssertEqual(
            viewModel.state,
            .failed("Valuation is not configured on this server.")
        )
    }

    func testATransportFailureIsReportedGenerically() async {
        let item = Item.fixture()
        let service = StubInventoryService(items: [item], failure: .transport(message: "offline"))
        let viewModel = ItemValuationViewModel(itemId: item.id, service: service)

        await viewModel.valuate()

        XCTAssertEqual(
            viewModel.state,
            .failed("Can't reach the server. Check your connection and try again.")
        )
    }

    func testResetReturnsToIdle() async {
        let item = Item.fixture()
        let service = StubInventoryService(items: [item])
        service.setValuation(valuation(for: item.id))
        let viewModel = ItemValuationViewModel(itemId: item.id, service: service)

        await viewModel.valuate()
        viewModel.reset()

        XCTAssertEqual(viewModel.state, .idle)
    }

    func testPriceFormattingUsesTheServerCurrency() {
        XCTAssertFalse(Price(amount: 45.5, currency: "USD").formatted.isEmpty)
        XCTAssertTrue(Price(amount: 45.5, currency: "USD").formatted.contains("45"))
    }

    func testSourceFallsBackToItsHostWhenUntitled() {
        let source = ValuationSource(
            uri: URL(string: "https://listings.example.com/x")!,
            title: nil
        )

        XCTAssertEqual(source.displayTitle, "listings.example.com")
    }
}
